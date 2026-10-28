/**
 * Asynchronous Parallel Task research: submission and live collection.
 *
 * Contracts this module owns:
 *
 *  - Submission is a recorded paid call (`paid-call.ts`): the effective request
 *    is recorded before money is spent, a replayed Pi invocation returns that
 *    record instead of submitting again, and an accepted run is handed off to
 *    collection.
 *  - Processor policy: `core` is the floor (`lite`/`base` are not offered for
 *    research) and `ultra2x` is the autonomous ceiling. A model-supplied
 *    argument is never treated as authorization for more.
 *  - One Task Group per Pi session. The run carries the local reference in its
 *    metadata, so a crash between submission and binding can be reconciled from
 *    the group instead of resubmitting.
 *  - Collection: every provider read (the run's event stream, its status, its
 *    result) happens here, and each fact goes to the Task run lifecycle
 *    (`task-run-lifecycle.ts`), which decides and commits. A closed stream is
 *    not completion: the run status decides.
 */

import type { Parallel } from "parallel-web";
import type { RunInput, TaskRun, TaskRunEventsResponse, TaskRunResult, TaskSpec } from "parallel-web/resources";
import { OPEN_RUN_STATES, TERMINAL_RUN_STATES, UNCONFIRMED_RUN_STATES, type ResearchStore } from "./store.ts";
import { providerSourcePolicy, sourcePolicy } from "./source-policy.ts";
import { createPaidCalls } from "./paid-call.ts";
import {
  createTaskRunLifecycle,
  providerStatus,
  TASK_FLOOR,
  TASK_PROCESSORS,
  type ProviderFact,
  type TaskProcessor,
} from "./task-run-lifecycle.ts";
import { clean, errorText, oneLine, replayReceipt } from "./receipt.ts";

export const TASK_CEILING: TaskProcessor = "ultra2x";

export function validateProcessor(value: string | undefined): TaskProcessor {
  const chosen = (value?.trim() || process.env.WEBTASKS_TASK_PROCESSOR?.trim() || TASK_FLOOR);
  if ((TASK_PROCESSORS as readonly string[]).includes(chosen)) return chosen as TaskProcessor;
  throw new Error(
    `processor must be one of ${TASK_PROCESSORS.join(", ")}.`,
  );
}

export type ResearchInput = {
  input: string | Record<string, unknown>;
  processor?: string;
  /** JSON Schema for structured output. Omit for a cited text report. */
  output_schema?: Record<string, unknown>;
  /** What the cited text report should contain, when output_schema is omitted. */
  output_description?: string;
  include_domains?: string[];
  exclude_domains?: string[];
  after_date?: string;
  /** Local reference of an earlier Task or answer to build on. */
  continue_from?: string;
};

export type TaskReceipt = { text: string; details: Record<string, unknown> };

/** The effective request a submission records before it is sent. */
type TaskIntent = {
  kind: "task";
  input: string | Record<string, unknown>;
  processor: TaskProcessor;
  output_schema?: Record<string, unknown>;
  output_description?: string;
  source_policy?: { include_domains?: string[]; exclude_domains?: string[]; after_date?: string };
  continue_from?: string;
};

type Options = {
  store: ResearchStore;
  sessionId: string;
  client: () => Promise<Parallel>;
  /** Wake the runtime's alert drain. */
  onAlerts: () => void;
  log?: (message: string) => void;
  sweepMs?: number;
  /** First reconnect delay for a run's event stream; it doubles up to five minutes. */
  retryMs?: number;
};

/** Reconnect delay bounds for a run's event stream. */
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 300_000;
/** Provider statuses after which a run's event stream has nothing more to say. */
const STREAM_ENDS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createTaskService(options: Options) {
  const { store, sessionId } = options;
  const log = options.log ?? (() => undefined);
  const client = options.client;
  const calls = createPaidCalls({ store, sessionId, client });
  const lifecycle = createTaskRunLifecycle({ store, sessionId, onAlerts: options.onAlerts, log });
  const active = new Map<string, AbortController>();
  const collecting = new Set<Promise<void>>();
  let groupCreation: Promise<string> | undefined;
  let sweep: ReturnType<typeof setInterval> | undefined;
  let stopping = false;

  function receipt(reference: string, processor: string, kind: string, contract: string): TaskReceipt {
    const lines = [
      `Research submitted: ${reference} (${processor}, ${kind}).`,
      `Contract: ${contract}`,
      "It runs in the background, and results usually take 5-15 minutes: progress updates and a completion alert arrive as messages, even after you end your turn.",
      "Keep working on the other parts of the task meanwhile. When nothing else is left, tell the user the research is running and end your turn; the completion alert brings you back.",
      `Read partial findings as they arrive with web_recall { reference: "${reference}" }. This job is submitted once; there is nothing to poll or resubmit.`,
    ];
    return {
      text: lines.join("\n"),
      details: { reference, state: "submitted", replayed: false, processor, hits: 0 },
    };
  }

  async function continuationId(reference: string): Promise<string> {
    const run = await store.run(sessionId, reference);
    if (!run) throw new Error(`${reference} is not a research record in this session`);
    const id = run.provider_interaction_id ?? (run.kind === "answer" ? run.provider_run_id : undefined);
    if (!id) throw new Error(`${reference} cannot be continued yet (state: ${run.state}); continue from a completed web_research run or web_answer`);
    return id;
  }

  async function ensureGroup(parallel: Parallel): Promise<string> {
    const existing = await store.groupForSession(sessionId);
    if (existing?.group_id && existing.state === "ready") return existing.group_id;
    // Concurrent first submissions share one creation, so the session keeps one group.
    groupCreation ??= (async () => {
      try {
        const group = await parallel.taskGroup.create({}, { maxRetries: 0 });
        await store.bindGroup(sessionId, group.taskgroup_id, "ready");
        return group.taskgroup_id;
      } catch (err) {
        await store.bindGroup(sessionId, existing?.group_id, "uncertain", errorText(err));
        throw err;
      }
    })().finally(() => { groupCreation = undefined; });
    return groupCreation;
  }

  /**
   * The output contract is the caller's decision, never the extension's: name a
   * JSON Schema for fields, or describe the text report you want. There is no
   * implicit schema, and no reliance on the provider's `auto` default.
   */
  function taskSpec(input: ResearchInput): { spec: TaskSpec; kind: string; described?: string } {
    const hasSchema = input.output_schema !== undefined;
    const description = clean(input.output_description);
    if (hasSchema && description) {
      throw new Error("Pass output_schema or output_description, not both: they are different output contracts");
    }
    if (!hasSchema && !description) {
      throw new Error("Say what the run must produce: output_schema (a JSON Schema object) or output_description (what the cited text report should contain)");
    }
    if (hasSchema) {
      if (!input.output_schema || typeof input.output_schema !== "object" || Array.isArray(input.output_schema)) {
        throw new Error("output_schema must be a JSON Schema object");
      }
      if (!("type" in input.output_schema) && !("properties" in input.output_schema)) {
        throw new Error("output_schema needs a JSON Schema `type` or `properties`");
      }
      return { spec: { output_schema: { type: "json", json_schema: input.output_schema } }, kind: "structured output" };
    }
    return { spec: { output_schema: { type: "text", description } }, kind: "cited text report", described: description };
  }

  async function submit(input: ResearchInput, call: { invocationId: string; signal?: AbortSignal }): Promise<TaskReceipt> {
    const raw = input.input;
    if (typeof raw === "string" ? !raw.trim() : !raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) {
      throw new Error("input needs a non-empty goal string, or a non-empty object of structured inputs");
    }
    const processor = validateProcessor(input.processor);
    const previousInteractionId = input.continue_from ? await continuationId(clean(input.continue_from)!) : undefined;
    const { spec: task_spec, kind, described } = taskSpec(input);
    const source_policy = providerSourcePolicy(sourcePolicy(input));

    const intent: TaskIntent = {
      kind: "task",
      input: raw,
      processor,
      output_schema: input.output_schema,
      output_description: described,
      source_policy,
      continue_from: clean(input.continue_from),
    };
    const outcome = await calls.run({
      kind: "task",
      label: "Research submission",
      intent,
      processor,
      invocation: call,
      // An accepted-but-unrecorded submission may exist: reconciliation finds it by its reference.
      uncertainAdvice: reference => `It may have started anyway: ${reference} is being checked and reports its result if it did, so it needs no new submission.`,
      send: async (parallel, { reference }) => {
        const groupId = await ensureGroup(parallel);
        const runInput: RunInput = {
          input: raw,
          processor,
          enable_events: true,
          task_spec,
          metadata: { webtasks_ref: reference },
          ...(source_policy ? { source_policy } : {}),
          ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
        };
        const added = await parallel.taskGroup.addRuns(groupId, { inputs: [runInput], default_task_spec: task_spec }, { maxRetries: 0 });
        const runId = added.run_ids?.[0];
        if (!runId) throw new Error("Parallel accepted the job without returning a run");
        try {
          // Bind the accepted run before anything else can fail: from here on it exists and is paid for.
          await lifecycle.bound(reference, { providerRunId: runId, groupId });
          if (added.event_cursor) await store.setGroupCursor(sessionId, added.event_cursor);
        } catch (err) {
          // Accepted means the outcome can no longer be a rejection, whatever failed here:
          // an error without an HTTP status is always settled as uncertain.
          throw new Error(`Parallel accepted the job, but recording it failed: ${errorText(err) ?? "unknown error"}`, { cause: err });
        }
        return { runId, parallel };
      },
      // No settle: the accepted run is handed off to collection.
    });

    if (outcome.replayed) {
      // Describe what was actually submitted, not the arguments of the replay.
      const { reference, run, hits } = outcome;
      const stored = outcome.intent ?? intent;
      const storedProcessor = stored.processor ?? processor;
      const storedKind = stored.output_schema !== undefined ? "structured output" : "cited text report";
      const contract = contractLine(storedProcessor, storedKind, stored.output_description, stored.source_policy, stored.continue_from);
      const { text, details } = replayReceipt({ noun: "research job", reference, state: run?.state ?? "unknown", hits, body: [`Contract: ${contract}`] });
      return { text, details: { ...details, processor: storedProcessor } };
    }
    const { reference, response: { runId, parallel } } = outcome;

    // The run is accepted and bound. Its first status read is best effort: collection reconciles the rest.
    try {
      const run = await parallel.taskRun.retrieve(runId, { maxRetries: 0 });
      await lifecycle.observed(reference, await factFor(runId, run));
    } catch (err) {
      log(`first status check for ${reference} failed: ${errorText(err) ?? "unknown error"}`);
    }

    void track(reference);
    options.onAlerts();
    return receipt(reference, processor, kind, contractLine(processor, kind, described, source_policy, clean(input.continue_from)));
  }

  /** The effective request, stated plainly so the caller can see what it asked for. */
  function contractLine(processor: string, kind: string, description: string | undefined, policy: TaskIntent["source_policy"], continueFrom: string | undefined): string {
    const parts = [processor, kind === "structured output" ? "JSON schema output" : `text report: "${oneLine(description ?? "", 100)}"`];
    const include = policy?.include_domains ?? [];
    const exclude = policy?.exclude_domains ?? [];
    if (include.length) parts.push(`only ${include.join(", ")}`);
    if (exclude.length) parts.push(`excluding ${exclude.join(", ")}`);
    if (policy?.after_date) parts.push(`published after ${policy.after_date}`);
    if (continueFrom) parts.push(`continues ${continueFrom}`);
    return parts.join("; ");
  }

  /**
   * What Parallel says about a run, as a lifecycle fact. A completed run's
   * result is fetched here; a failed fetch leaves it out, and the lifecycle
   * decides whether to wait for another attempt.
   */
  async function factFor(runId: string, providerRun: TaskRun | undefined, reference?: string): Promise<ProviderFact> {
    const status = providerStatus(providerRun);
    let result: TaskRunResult | undefined;
    if (status === "completed") {
      try {
        result = await (await client()).taskRun.result(runId, { timeout: 0 }, { maxRetries: 0, timeout: 60_000 });
      } catch (err) {
        log(`result fetch for ${reference ?? runId} failed: ${errorText(err) ?? "unknown error"}`);
      }
    }
    return {
      status,
      interactionId: providerRun?.interaction_id ?? undefined,
      error: (providerRun as { error?: unknown } | undefined)?.error,
      run: providerRun,
      result,
    };
  }

  /** Store one received event. Returns whether it was a replay. */
  async function observe(reference: string, event: TaskRunEventsResponse): Promise<boolean> {
    const type = typeof (event as { type?: unknown }).type === "string" ? (event as { type: string }).type : "unknown";
    const timestamp = (event as { timestamp?: unknown }).timestamp;
    const message = (event as { message?: unknown }).message;
    const eventId = (event as { event_id?: unknown }).event_id;
    const dedupKey = typeof eventId === "string" && eventId
      ? `id:${eventId}`
      : type === "task_run.progress_stats"
        ? "stats"
        : `evt:${type}:${typeof timestamp === "string" ? timestamp : ""}:${typeof message === "string" ? oneLine(message, 400) : ""}:${JSON.stringify((event as { source_stats?: unknown }).source_stats ?? null)}`;

    const { duplicate } = await store.appendObservation({
      sessionId, reference, source: "run_sse", eventType: type,
      providerEventId: typeof eventId === "string" && eventId ? eventId : undefined,
      dedupKey,
      replaceIfExists: type === "task_run.progress_stats",
      payload: event,
    });
    if (duplicate) return true;

    if (type === "task_run.progress_msg.result" && typeof message === "string" && message.trim()) {
      await store.appendEvidence(sessionId, reference, {
        kind: "finding",
        origin: "provider_finding",
        title: "Intermediate finding",
        body: message,
        pointer: `progress_msg.result@${typeof timestamp === "string" ? timestamp : "unknown"}`,
        payload: event,
      });
    }
    return false;
  }

  /** Collect one run's events until it settles or the runtime stops. */
  async function track(reference: string): Promise<void> {
    if (stopping || active.has(reference)) return;
    const controller = new AbortController();
    active.set(reference, controller);
    const work = (async () => {
      try {
        await collect(reference, controller);
      } catch (err) {
        if (!stopping) log(`collection for ${reference} stopped: ${errorText(err) ?? "unknown error"}`);
      } finally {
        active.delete(reference);
      }
    })();
    collecting.add(work);
    try {
      await work;
    } finally {
      collecting.delete(work);
    }
  }

  async function collect(reference: string, controller: AbortController): Promise<void> {
    // Back off while the provider or the network is unavailable, and report one failure per streak,
    // so a missing key or an outage does not turn into a notification every few seconds.
    const retryMinMs = options.retryMs ?? RETRY_MIN_MS;
    let delayMs = retryMinMs;
    let failures = 0;
    const failed = (message: string) => {
      if (failures++ === 0) log(message);
    };
    while (!stopping && !controller.signal.aborted) {
      const run = await store.run(sessionId, reference);
      const runId = run?.provider_run_id;
      if (!runId || TERMINAL_RUN_STATES.has(run.state)) return;
      let ended = false;
      let fresh = false;
      try {
        const stream = await (await client()).taskRun.events(runId, { signal: controller.signal, maxRetries: 0 });
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          const duplicate = await observe(reference, event);
          if (!duplicate) fresh = true;
          const providerRun = (event as { run?: TaskRun }).run;
          if (!providerRun) continue;
          // A reconnect replays recorded events. Only a replayed end is worth another look:
          // it may not have been committed (its result fetch failed); the rest were applied.
          if (duplicate && !STREAM_ENDS.has(providerStatus(providerRun))) continue;
          const { open } = await lifecycle.observed(reference, await factFor(runId, providerRun, reference));
          if (!open) return;
          if (STREAM_ENDS.has(providerStatus(providerRun))) {
            // Seen, but not committed (a missing result or a failed commit): try again after a pause.
            ended = true;
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        failed(`run stream for ${reference} ended: ${errorText(err) ?? "unknown error"}`);
      }
      if (controller.signal.aborted) return;
      // A stream close is not completion: the provider's status decides.
      if (!ended && await reconcileRun(reference)) return;
      if (fresh) {
        delayMs = retryMinMs;
        failures = 0;
      }
      await sleep(delayMs, controller.signal);
      delayMs = Math.min(RETRY_MAX_MS, delayMs * 2);
    }
  }

  /** Ask the provider about one run and hand the answer to the lifecycle. Returns whether the run settled. */
  async function reconcileRun(reference: string): Promise<boolean> {
    const run = await store.run(sessionId, reference);
    if (!run?.provider_run_id) return false;
    if (TERMINAL_RUN_STATES.has(run.state)) return true;
    try {
      const providerRun = await (await client()).taskRun.retrieve(run.provider_run_id, { maxRetries: 0 });
      const { open } = await lifecycle.observed(reference, await factFor(run.provider_run_id, providerRun, reference));
      return !open;
    } catch (err) {
      log(`reconciliation for ${reference} failed: ${errorText(err) ?? "unknown error"}`);
      return false;
    }
  }

  /**
   * Recover a submission whose provider id was never bound, by matching the
   * local reference carried in the run metadata inside the session's group.
   */
  async function recoverUnbound(reference: string): Promise<boolean> {
    const group = await store.groupForSession(sessionId);
    if (!group?.group_id) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const stream = await (await client()).taskGroup.getRuns(group.group_id, { include_input: true }, { signal: controller.signal, maxRetries: 0 });
      for await (const event of stream) {
        const run = (event as { run?: TaskRun }).run;
        if (!run) continue;
        const metadata = (run as { metadata?: Record<string, unknown> | null }).metadata;
        if (metadata?.webtasks_ref !== reference) continue;
        await lifecycle.bound(reference, { providerRunId: run.run_id, groupId: group.group_id, interactionId: run.interaction_id ?? undefined });
        controller.abort();
        return true;
      }
    } catch (err) {
      if (!controller.signal.aborted) log(`group reconciliation failed: ${errorText(err) ?? "unknown error"}`);
    } finally {
      clearTimeout(timer);
    }
    return false;
  }

  /** Session start: settle what finished while Pi was closed, resume what is still open. */
  async function reconcile(): Promise<void> {
    const runs = (await store.listRuns(sessionId, { states: [...OPEN_RUN_STATES], limit: 200 })).filter(run => run.kind === "task");
    for (const run of runs) {
      if (stopping) return;
      if (!run.provider_run_id && UNCONFIRMED_RUN_STATES.has(run.state)) await recoverUnbound(run.reference);
      const settled = await reconcileRun(run.reference);
      if (!settled) void track(run.reference);
    }
    options.onAlerts();
  }

  /** Queue due progress alerts. */
  async function tick(): Promise<void> {
    if (stopping) return;
    await lifecycle.tick();
  }

  function start(): void {
    stopping = false;
    if (sweep) return;
    sweep = setInterval(() => {
      // A background sweep must never take Pi down: report and try again next time.
      void tick().catch(err => log(`progress sweep failed: ${errorText(err) ?? "unknown error"}`));
    }, options.sweepMs ?? 15_000);
    // Never keep a Pi process alive just for the schedule.
    (sweep as unknown as { unref?: () => void }).unref?.();
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (sweep) clearInterval(sweep);
    sweep = undefined;
    for (const controller of active.values()) controller.abort();
    // Let aborted collectors unwind before the caller closes the store under them.
    await Promise.allSettled([...collecting]);
    active.clear();
  }

  return { submit, reconcile, tick, track, stop, start };
}

export type TaskService = ReturnType<typeof createTaskService>;
