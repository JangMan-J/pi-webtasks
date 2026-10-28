/**
 * Asynchronous Parallel Task research: submission, live collection, recovery,
 * and progress/completion alerts.
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
 *  - Progress is collected continuously from the run's event stream. A closed
 *    stream is not completion: the run status decides.
 *  - Alerts are persisted before delivery, scheduled from published processor
 *    latency (not deadlines or percentages), and coalesced per interval.
 *  - Completed output, its field basis, and its cited sources are committed in
 *    one local transaction with the run state and the completion alert.
 */

import type { Parallel } from "parallel-web";
import type { FieldBasis, RunInput, TaskRun, TaskRunEventsResponse, TaskRunResult, TaskSpec } from "parallel-web/resources";
import type { AlertInput, CitationInput, EvidenceInput, ResearchStore, RunState, SearchHit } from "./store.ts";
import { createPaidCalls } from "./paid-call.ts";

export const TASK_PROCESSORS = ["core", "core2x", "pro", "ultra", "ultra2x"] as const;
export type TaskProcessor = (typeof TASK_PROCESSORS)[number];
export const TASK_FLOOR: TaskProcessor = "core";
export const TASK_CEILING: TaskProcessor = "ultra2x";

/**
 * Progress guidance per processor: one third of the lower of the two published
 * upper latency estimates (processor guide and pricing page). These are
 * guidance for "send an update this often", never deadlines or percentages.
 * Override with WEBTASKS_PROGRESS_MS='{"core":100000,...}'.
 */
export const PROGRESS_INTERVALS_MS: Record<TaskProcessor, number> = {
  core: 100_000,
  core2x: 200_000,
  pro: 200_000,
  ultra: 500_000,
  ultra2x: 500_000,
};

export function progressIntervals(): Record<TaskProcessor, number> {
  const raw = process.env.WEBTASKS_PROGRESS_MS?.trim();
  if (!raw) return PROGRESS_INTERVALS_MS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = { ...PROGRESS_INTERVALS_MS };
    for (const processor of TASK_PROCESSORS) {
      const value = parsed[processor];
      if (typeof value === "number" && Number.isFinite(value) && value >= 5_000) merged[processor] = Math.trunc(value);
    }
    return merged;
  } catch {
    return PROGRESS_INTERVALS_MS;
  }
}

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

type Options = {
  store: ResearchStore;
  sessionId: string;
  client: () => Promise<Parallel>;
  /** Wake the runtime's alert drain. */
  onAlerts: () => void;
  now?: () => number;
  log?: (message: string) => void;
  sweepMs?: number;
  /** First reconnect delay for a run's event stream; it doubles up to five minutes. */
  retryMs?: number;
};

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "action_required"]);
/** Reconnect delay bounds for a run's event stream. */
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 300_000;
/** Result fetches for a completed run before it is committed without output. */
const RESULT_ATTEMPTS = 5;
const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "cancelling"]);

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

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

function runStatus(run: { status?: unknown } | undefined): string {
  const status = (run as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : "unknown";
}

function oneLine(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return oneLine(error);
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return oneLine(message);
    try { return oneLine(JSON.stringify(error)); } catch { return undefined; }
  }
  return oneLine(String(error));
}

/** Build evidence and citation links from a completed Task output and its basis. */
function outputEvidence(output: TaskRunResult["output"] | undefined): { evidence: EvidenceInput[]; citations: CitationInput[] } {
  if (!output) return { evidence: [], citations: [] };
  const evidence: EvidenceInput[] = [];
  const citations: CitationInput[] = [];
  const basis: FieldBasis[] = Array.isArray(output.basis) ? output.basis : [];

  const sourceRefs = new Map<string, string>();
  for (const field of basis) {
    for (const citation of field.citations ?? []) {
      const url = clean(citation.url);
      if (!url || sourceRefs.has(url)) continue;
      const ref = `src:${sourceRefs.size}`;
      sourceRefs.set(url, ref);
      const excerpts = (citation.excerpts ?? []).filter(text => text.trim());
      evidence.push({
        kind: "source",
        origin: "provider_source",
        title: clean(citation.title),
        url,
        pointer: `basis[${basis.indexOf(field)}].citations`,
        body: excerpts.length ? excerpts.join("\n\n") : url,
        payload: citation,
        ref,
      });
    }
  }

  const content = output.content;
  if (typeof content === "string") {
    evidence.push({ kind: "report", origin: "provider_report", title: "Research report", body: content, pointer: "output.content", payload: output, ref: "report" });
    for (const field of basis) {
      for (const citation of field.citations ?? []) {
        const url = clean(citation.url);
        const ref = url ? sourceRefs.get(url) : undefined;
        if (!ref) continue;
        citations.push({
          evidence: "report",
          source: ref,
          claim: oneLine(field.reasoning ?? field.field ?? "", 400) || undefined,
          url,
          title: clean(citation.title),
        });
      }
    }
    return { evidence, citations };
  }

  const fields = content && typeof content === "object" && !Array.isArray(content) ? Object.entries(content) : [];
  evidence.push({
    kind: "structured",
    origin: "provider_structured",
    title: "Structured research output",
    body: JSON.stringify(content, null, 2),
    pointer: "output.content",
    payload: output,
    ref: "document",
  });
  for (const [name, value] of fields) {
    const ref = `field:${name}`;
    evidence.push({
      kind: "structured",
      origin: "provider_structured",
      title: name,
      body: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      pointer: `output.content.${name}`,
      ref,
    });
  }
  for (const field of basis) {
    const name = typeof field.field === "string" ? field.field : undefined;
    const target = name && fields.some(([candidate]) => candidate === name) ? `field:${name}` : "document";
    for (const citation of field.citations ?? []) {
      const url = clean(citation.url);
      const source = url ? sourceRefs.get(url) : undefined;
      if (!source) continue;
      citations.push({
        evidence: target,
        source,
        claim: oneLine(field.reasoning ?? field.field ?? "", 400) || undefined,
        url,
        title: clean(citation.title),
      });
    }
  }
  return { evidence, citations };
}

function summarizeOutput(output: TaskRunResult["output"] | undefined, sources: number): string {
  if (!output) return "completed without retrievable output";
  if (typeof output.content === "string") {
    const firstLine = output.content.split("\n").map(line => line.replace(/^#+\s*/, "").trim()).find(Boolean);
    return oneLine(firstLine ?? output.content.replace(/\s+/g, " "), 120);
  }
  const fields = output.content && typeof output.content === "object" ? Object.keys(output.content) : [];
  return fields.length ? `structured output: ${fields.slice(0, 6).join(", ")}${fields.length > 6 ? `, +${fields.length - 6} more` : ""}${sources ? ` (${sources} cited sources)` : ""}` : "structured output";
}

export function createTaskService(options: Options) {
  const { store, sessionId } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const client = options.client;
  const calls = createPaidCalls({ store, sessionId, client });
  const intervals = progressIntervals();
  const active = new Map<string, AbortController>();
  const collecting = new Set<Promise<void>>();
  /** Completed runs whose result could not be fetched yet, with the attempts made so far. */
  const resultAttempts = new Map<string, number>();
  let groupCreation: Promise<string> | undefined;
  let sweep: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let ticking = false;

  function receipt(reference: string, state: string, replayed: boolean, processor: string, kind: string, contract: string | undefined, hits: SearchHit[]): TaskReceipt {
    const lines = replayed
      ? [
        `This research job was already submitted as ${reference} (state: ${state}); it is not sent again.`,
        contract ? `Contract: ${contract}` : undefined,
        hits.length ? `Stored evidence so far: ${hits.length} item(s).` : "No evidence is stored for it yet.",
        ...hits.map(hit => `- ${hit.handle} (${hit.kind}) ${hit.title ?? hit.url ?? ""}`.trimEnd()),
      ].filter((line): line is string => line !== undefined)
      : [
        `Research submitted: ${reference} (${processor}, ${kind}).`,
        contract ? `Contract: ${contract}` : undefined,
        "It runs in the background, and results usually take 5-15 minutes: progress updates and a completion alert arrive as messages, even after you end your turn.",
        "Keep working on the other parts of the task meanwhile. When nothing else is left, tell the user the research is running and end your turn; the completion alert brings you back.",
        `Read partial findings as they arrive with web_recall { reference: "${reference}" }. This job is submitted once; there is nothing to poll or resubmit.`,
      ].filter((line): line is string => line !== undefined);
    return {
      text: lines.join("\n"),
      details: { reference, state, replayed, processor, hits: hits.length },
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

  function sourcePolicy(input: ResearchInput) {
    const include = (input.include_domains ?? []).map(domain => domain.trim()).filter(Boolean);
    const exclude = (input.exclude_domains ?? []).map(domain => domain.trim()).filter(Boolean);
    if (include.length + exclude.length > 200) throw new Error("include_domains and exclude_domains together take at most 200 entries");
    const afterDate = clean(input.after_date);
    if (afterDate && (!/^\d{4}-\d{2}-\d{2}$/.test(afterDate) || Number.isNaN(Date.parse(afterDate)))) {
      throw new Error("after_date must be a calendar date in YYYY-MM-DD form");
    }
    if (!include.length && !exclude.length && !afterDate) return undefined;
    return {
      ...(afterDate ? { after_date: afterDate } : {}),
      ...(include.length ? { include_domains: include } : {}),
      ...(exclude.length ? { exclude_domains: exclude } : {}),
    };
  }

  async function submit(input: ResearchInput, call: { invocationId: string; signal?: AbortSignal }): Promise<TaskReceipt> {
    const raw = input.input;
    if (typeof raw === "string" ? !raw.trim() : !raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) {
      throw new Error("input needs a non-empty goal string, or a non-empty object of structured inputs");
    }
    const processor = validateProcessor(input.processor);
    const previousInteractionId = input.continue_from ? await continuationId(clean(input.continue_from)!) : undefined;
    const { spec: task_spec, kind, described } = taskSpec(input);
    const source_policy = sourcePolicy(input);

    const intent = {
      kind: "task" as const,
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
          await store.bindProviderRun({ sessionId, reference, providerRunId: runId, groupId, state: "accepted" });
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
      const { reference, run, hits } = outcome;
      // Describe what was actually submitted, not the arguments of the replay.
      const stored = run?.intent as { processor?: string; output_schema?: unknown; output_description?: string; source_policy?: Record<string, unknown>; continue_from?: string } | undefined;
      const storedProcessor = stored?.processor ?? processor;
      const storedKind = stored ? (stored.output_schema !== undefined ? "structured output" : "cited text report") : kind;
      return receipt(reference, run?.state ?? "unknown", true, storedProcessor, storedKind,
        contractLine(storedProcessor, storedKind, stored ? stored.output_description : described, stored?.source_policy, stored?.continue_from), hits);
    }
    const { reference, response: { runId, parallel } } = outcome;

    // The run is accepted and bound. Its first status read is best effort: collection reconciles the rest.
    try {
      const run = await parallel.taskRun.retrieve(runId, { maxRetries: 0 });
      await store.bindProviderRun({
        sessionId, reference, providerRunId: runId, interactionId: run.interaction_id ?? undefined,
        state: runStatus(run) === "running" ? "pending" : "accepted",
      });
      if (runStatus(run) === "running") await startSchedule(reference, processor);
    } catch (err) {
      log(`first status check for ${reference} failed: ${errorText(err) ?? "unknown error"}`);
    }

    void track(reference);
    options.onAlerts();
    return receipt(reference, "submitted", false, processor, kind, contractLine(processor, kind, described, source_policy, clean(input.continue_from)), []);
  }

  /** The effective request, stated plainly so the caller can see what it asked for. */
  function contractLine(processor: string, kind: string, description: string | undefined, policy: Record<string, unknown> | undefined, continueFrom: string | undefined): string {
    const parts = [processor, kind === "structured output" ? "JSON schema output" : `text report: "${oneLine(description ?? "", 100)}"`];
    const include = (policy?.include_domains as string[] | undefined) ?? [];
    const exclude = (policy?.exclude_domains as string[] | undefined) ?? [];
    if (include.length) parts.push(`only ${include.join(", ")}`);
    if (exclude.length) parts.push(`excluding ${exclude.join(", ")}`);
    if (typeof policy?.after_date === "string") parts.push(`published after ${policy.after_date}`);
    if (continueFrom) parts.push(`continues ${continueFrom}`);
    return parts.join("; ");
  }

  function scheduleFor(processor: string): number {
    return intervals[(processor as TaskProcessor)] ?? intervals[TASK_FLOOR];
  }

  async function startSchedule(reference: string, processor: string): Promise<void> {
    const run = await store.run(sessionId, reference);
    if (!run || run.running_at !== undefined) return;
    const intervalMs = scheduleFor(processor);
    const runningAt = now();
    await store.markRunning(sessionId, reference, { runningAt, intervalMs, nextAlertAt: runningAt + intervalMs });
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
      if (!runId) return;
      if (TERMINAL.has(run.state)) return;
      let terminal = false;
      let fresh = false;
      try {
        const stream = await (await client()).taskRun.events(runId, { signal: controller.signal, maxRetries: 0 });
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          if (!(await observe(reference, event))) fresh = true;
          const status = runStatus((event as { run?: { status?: string } }).run);
          if (status === "running") await startSchedule(reference, run?.processor ?? TASK_FLOOR);
          if (TERMINAL.has(status)) {
            await settle(reference, (event as { run?: TaskRun }).run);
            terminal = true;
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        failed(`run stream for ${reference} ended: ${errorText(err) ?? "unknown error"}`);
      }
      if (controller.signal.aborted) return;
      if (terminal) {
        // The terminal event was seen; if committing it failed, retry rather than drop the run.
        const after = await store.run(sessionId, reference);
        if (after && TERMINAL.has(after.state)) return;
      } else if (await reconcileRun(reference)) {
        // A stream close is not completion: the provider's status decides.
        return;
      }
      if (fresh) {
        delayMs = retryMinMs;
        failures = 0;
      }
      await sleep(delayMs, controller.signal);
      delayMs = Math.min(RETRY_MAX_MS, delayMs * 2);
    }
  }

  async function settle(reference: string, knownRun?: TaskRun): Promise<void> {
    const run = await store.run(sessionId, reference);
    if (!run || TERMINAL.has(run.state)) return;
    const runId = run.provider_run_id ?? knownRun?.run_id;
    if (!runId) return;
    let providerRun = knownRun;
    if (!providerRun) {
      try {
        providerRun = await (await client()).taskRun.retrieve(runId, { maxRetries: 0 });
      } catch (err) {
        log(`status check for ${reference} failed: ${errorText(err) ?? "unknown error"}`);
      }
    }
    const status = runStatus(providerRun);
    if (ACTIVE.has(status)) return;
    if (!TERMINAL.has(status)) {
      log(`run ${reference} reported an unknown status ${status}`);
      return;
    }

    if (status === "completed") {
      let result: TaskRunResult | undefined;
      try {
        result = await (await client()).taskRun.result(runId, { timeout: 0 }, { maxRetries: 0, timeout: 60_000 });
      } catch (err) {
        log(`result fetch for ${reference} failed: ${errorText(err) ?? "unknown error"}`);
      }
      const stateOutput = (await latestStateEvent(reference)) as { output?: TaskRunResult["output"] } | undefined;
      const output = result?.output ?? stateOutput?.output;
      if (!output) {
        // A completed run is final: committing it without output would lose the result for good.
        // Leave it open so collection retries, and give up only after repeated failures.
        const attempts = (resultAttempts.get(reference) ?? 0) + 1;
        resultAttempts.set(reference, attempts);
        if (attempts < RESULT_ATTEMPTS) return;
      }
      resultAttempts.delete(reference);
      const { evidence, citations } = outputEvidence(output);
      const summary = summarizeOutput(output, evidence.filter(item => item.kind === "source").length);
      const completion = await store.completeRun({
        sessionId, reference, state: "completed", summary,
        providerRunId: runId,
        providerInteractionId: providerRun?.interaction_id ?? undefined,
        rawResult: result ?? stateOutput ?? { run: providerRun },
        evidence,
        citations,
        alerts: [{
          kind: "completion",
          headline: `Research completed: ${summary}`,
          body: completionBody(reference, evidence),
          dedup_key: `task-complete:${reference}`,
        }],
      }).catch(err => {
        log(`completion for ${reference} could not be committed: ${errorText(err) ?? "unknown error"}`);
        return undefined;
      });
      if (completion) options.onAlerts();
      return;
    }

    const reason = errorText((providerRun as { error?: unknown } | undefined)?.error) ?? status;
    const state: RunState = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "action_required";
    const alert: AlertInput = {
      kind: status === "failed" ? "failure" : "action_required",
      headline: status === "failed" ? `Research failed: ${oneLine(reason, 120)}` : `Research needs attention: ${status.replace(/_/g, " ")}`,
      body: `Run ${reference} ended as ${status}${reason && reason !== status ? `: ${reason}` : ""}. Read what it stored with web_recall { reference: "${reference}" }.`,
      dedup_key: `task-${state}:${reference}`,
    };
    await store.completeRun({
      sessionId, reference, state,
      error: reason,
      providerRunId: runId,
      providerInteractionId: providerRun?.interaction_id ?? run.provider_interaction_id,
      rawResult: { run: providerRun },
      alerts: [alert],
    }).catch(err => log(`terminal state for ${reference} could not be committed: ${errorText(err) ?? "unknown error"}`));
    options.onAlerts();
  }

  async function latestStateEvent(reference: string): Promise<unknown> {
    return (await store.latestObservations(sessionId, reference, { eventType: "task_run.state", limit: 1 }))[0]?.payload;
  }

  function completionBody(reference: string, evidence: EvidenceInput[]): string {
    const sources = evidence.filter(item => item.kind === "source").length;
    const fields = evidence.filter(item => item.kind === "structured").length;
    const parts = [sources ? `${sources} cited source(s)` : undefined, fields ? `${fields} structured field(s)` : undefined].filter(Boolean);
    return [
      `Run ${reference} completed${parts.length ? ` with ${parts.join(" and ")}` : ""}.`,
      `Read the report with web_recall { reference: "${reference}" }, or read one item by handle.`,
    ].join(" ");
  }

  /** Ask the provider about one run and settle it if it is no longer active. */
  async function reconcileRun(reference: string): Promise<boolean> {
    const run = await store.run(sessionId, reference);
    if (!run || !run.provider_run_id) return false;
    if (run.state !== "accepted" && run.state !== "pending" && run.state !== "uncertain") return false;
    try {
      const providerRun = await (await client()).taskRun.retrieve(run.provider_run_id, { maxRetries: 0 });
      await store.bindProviderRun({
        sessionId, reference, providerRunId: run.provider_run_id,
        interactionId: providerRun.interaction_id ?? undefined,
        state: runStatus(providerRun) === "running" ? "pending" : run.state === "uncertain" ? "uncertain" : "accepted",
      });
      if (runStatus(providerRun) === "running") await startSchedule(reference, run.processor ?? TASK_FLOOR);
      if (TERMINAL.has(runStatus(providerRun))) {
        await settle(reference, providerRun);
        // Settled only when the terminal state was committed; otherwise collection keeps trying.
        const after = await store.run(sessionId, reference);
        return after !== undefined && TERMINAL.has(after.state);
      }
      return false;
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
        await store.bindProviderRun({
          sessionId, reference, providerRunId: run.run_id, interactionId: run.interaction_id ?? undefined,
          groupId: group.group_id,
          state: runStatus(run) === "running" ? "pending" : runStatus(run) === "queued" ? "accepted" : "uncertain",
        });
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

  /** Session start: settle what finished while Pi was closed, resume what is still active. */
  async function reconcile(): Promise<void> {
    const runs = (await store.listRuns(sessionId, { states: ["submitting", "accepted", "pending", "uncertain"], limit: 200 })).filter(run => run.kind === "task");
    for (const run of runs) {
      if (stopping) return;
      if (!run.provider_run_id) {
        if (run.state === "submitting" || run.state === "uncertain") await recoverUnbound(run.reference);
      }
      const settled = await reconcileRun(run.reference);
      if (!settled) void track(run.reference);
    }
    options.onAlerts();
  }

  /** Queue due progress alerts and advance their schedules. */
  async function tick(): Promise<void> {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const due = await store.runsNeedingProgress(sessionId, now());
      for (const run of due) {
        const intervalMs = run.alert_interval_ms ?? scheduleFor(run.processor ?? TASK_FLOOR);
        const latest = await latestProgress(run.reference);
        const sources = latest.sources;
        const headline = sources !== undefined
          ? `Research still running (${run.processor ?? TASK_FLOOR}): ${sources} source(s) considered`
          : `Research still running (${run.processor ?? TASK_FLOOR})`;
        await store.enqueueAlert(sessionId, run.reference, {
          kind: "progress",
          headline,
          body: [
            latest.finding ? `Latest finding: ${oneLine(latest.finding, 220)}` : latest.message ? `Latest activity: ${oneLine(latest.message, 220)}` : "No new details yet; the run is still active.",
            `Partial evidence so far: web_recall { reference: "${run.reference}" }.`,
          ].join(" "),
          dedup_key: `task-progress:${run.reference}:${Math.floor(now() / intervalMs)}`,
        });
        await store.advanceProgress(sessionId, run.reference, now() + intervalMs);
      }
      if (due.length) options.onAlerts();
    } finally {
      ticking = false;
    }
  }

  async function latestProgress(reference: string): Promise<{ sources?: number; message?: string; finding?: string }> {
    // Newest first: the first value of each kind is the latest one.
    const events = await store.latestObservations(sessionId, reference, { limit: 100 });
    let sources: number | undefined;
    let message: string | undefined;
    let finding: string | undefined;
    for (const event of events) {
      const payload = event.payload as { source_stats?: { num_sources_considered?: number | null }; num_sources_considered?: number | null; message?: string };
      const considered = payload?.source_stats?.num_sources_considered ?? payload?.num_sources_considered;
      if (sources === undefined && typeof considered === "number") sources = considered;
      if (typeof payload?.message === "string") {
        message ??= payload.message;
        if (finding === undefined && event.eventType.endsWith(".result")) finding = payload.message;
      }
      if (sources !== undefined && message !== undefined && finding !== undefined) break;
    }
    return { sources, message, finding };
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
