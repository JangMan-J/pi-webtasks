/**
 * The Task run lifecycle: what a provider fact does to a local Task run, and the
 * progress timetable while it runs.
 *
 * Callers report facts; this module decides and commits. Nothing here talks to
 * Parallel: the collection loop in `task-service.ts` reads the event stream, the
 * run status, and the result, and hands each fact over. That keeps every
 * transition testable with a local store and plain values.
 *
 *  - `bound`: Parallel accepted this run under this provider id. An unconfirmed
 *    run (`submitting`, `uncertain`) becomes `accepted`.
 *  - `observed`: Parallel reports the run with this status. Any report about a
 *    bound run confirms it. `running` makes it `pending` and starts (or, after
 *    `action_required`, restarts) its progress timetable. `queued` and
 *    `cancelling` change nothing more. `action_required` is alerted once per
 *    entry and stays watched. `completed`, `failed`, and `cancelled` settle it
 *    with its evidence and alert in one transaction. Returns whether the run is
 *    still open, which is whether collection should keep watching it.
 *  - `tick`: queue the progress alerts that are due and advance their schedules.
 *
 * A terminal run is never moved: the store's guards enforce that inside the
 * same statement as each write, so a late or replayed fact changes nothing.
 */

import type { FieldBasis, TaskRunResult } from "parallel-web/resources";
import {
  OPEN_RUN_STATES,
  TERMINAL_RUN_STATES,
  UNCONFIRMED_RUN_STATES,
  type AlertInput,
  type CitationInput,
  type EvidenceInput,
  type ResearchStore,
  type RunState,
} from "./store.ts";
import { clean, errorText, oneLine } from "./receipt.ts";

export const TASK_PROCESSORS = ["core", "core2x", "pro", "ultra", "ultra2x"] as const;
export type TaskProcessor = (typeof TASK_PROCESSORS)[number];
export const TASK_FLOOR: TaskProcessor = "core";

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

/** Provider statuses that settle a run. */
const SETTLING: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
/** Provider statuses of a run that is still active and needs nothing from us. */
const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "cancelling"]);
/** Result fetches for a completed run before it is committed without output. */
const RESULT_ATTEMPTS = 5;

/** One thing Parallel said about a run. */
export type ProviderFact = {
  /** The provider run status (`queued`, `running`, `completed`, ...). */
  status: string;
  interactionId?: string;
  /** The provider's error object or message, for a failed or halted run. */
  error?: unknown;
  /** The provider run object, kept with a settled run. */
  run?: unknown;
  /** For `completed`: the fetched result, or undefined when the fetch failed. */
  result?: TaskRunResult;
};

type Options = {
  store: ResearchStore;
  sessionId: string;
  /** Alerts were committed: wake the delivery. */
  onAlerts?: () => void;
  log?: (message: string) => void;
  intervals?: Record<TaskProcessor, number>;
};

/** The provider status of a run-shaped value, or "unknown". */
export function providerStatus(run: unknown): string {
  const status = (run as { status?: unknown } | null | undefined)?.status;
  return typeof status === "string" ? status : "unknown";
}

export function createTaskRunLifecycle(options: Options) {
  const { store, sessionId } = options;
  const log = options.log ?? (() => undefined);
  const onAlerts = options.onAlerts ?? (() => undefined);
  const intervals = options.intervals ?? progressIntervals();
  /** Completed runs whose result could not be fetched yet, with the attempts made so far. */
  const resultAttempts = new Map<string, number>();
  let ticking = false;

  function intervalFor(processor: string | undefined): number {
    return intervals[processor as TaskProcessor] ?? intervals[TASK_FLOOR];
  }

  async function bound(reference: string, input: { providerRunId: string; groupId?: string; interactionId?: string }): Promise<void> {
    await store.bindProviderRun({ sessionId, reference, ...input });
  }

  async function observed(reference: string, fact: ProviderFact): Promise<{ open: boolean }> {
    const run = await store.run(sessionId, reference);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return { open: false };
    const status = fact.status;

    // Any report about a bound run confirms it exists, and may carry its interaction id.
    if (run.provider_run_id && (UNCONFIRMED_RUN_STATES.has(run.state) || (fact.interactionId && fact.interactionId !== run.provider_interaction_id))) {
      await store.bindProviderRun({ sessionId, reference, providerRunId: run.provider_run_id, interactionId: fact.interactionId });
    }

    if (status === "running") {
      await store.markRunning(sessionId, reference, intervalFor(run.processor));
      return { open: true };
    }
    if (ACTIVE.has(status)) return { open: true };
    if (status === "action_required") {
      const reason = errorText(fact.error);
      const moved = await store.transitionRun({
        sessionId, reference, from: OPEN_RUN_STATES, to: "action_required", error: reason,
        alert: {
          kind: "action_required",
          headline: "Research needs attention: Parallel reports action required",
          body: [
            `Run ${reference} is halted at Parallel with status action_required${reason ? `: ${reason}` : ""}.`,
            "It is still watched: if it resumes or ends, that arrives as another alert.",
            `Read what it stored so far with web_recall { reference: "${reference}" }.`,
          ].join(" "),
          // One alert per entry into the state: a run that resumes and halts again is alerted again.
          dedup_key: `task-action_required:${reference}:${store.now()}`,
        },
      });
      if (moved) onAlerts();
      return { open: true };
    }
    if (!SETTLING.has(status)) {
      log(`run ${reference} reported an unknown status ${status}`);
      return { open: true };
    }
    return settle(reference, run.provider_run_id, run.provider_interaction_id, fact);
  }

  async function settle(reference: string, providerRunId: string | undefined, knownInteraction: string | undefined, fact: ProviderFact): Promise<{ open: boolean }> {
    const status = fact.status as "completed" | "failed" | "cancelled";
    const interactionId = fact.interactionId ?? knownInteraction;

    if (status === "completed") {
      const stateOutput = (await latestStateEvent(reference)) as { output?: TaskRunResult["output"] } | undefined;
      const output = fact.result?.output ?? stateOutput?.output;
      if (!output) {
        // A completed run is final: committing it without output would lose the result for good.
        // Leave it open so collection fetches again, and give up only after repeated failures.
        const attempts = (resultAttempts.get(reference) ?? 0) + 1;
        resultAttempts.set(reference, attempts);
        if (attempts < RESULT_ATTEMPTS) return { open: true };
      }
      resultAttempts.delete(reference);
      const { evidence, citations } = outputEvidence(output);
      const summary = summarizeOutput(output, evidence.filter(item => item.kind === "source").length);
      const committed = await store.completeRun({
        sessionId, reference, state: "completed", summary,
        providerRunId, providerInteractionId: interactionId,
        rawResult: fact.result ?? stateOutput ?? { run: fact.run },
        evidence,
        citations,
        alerts: [{
          kind: "completion",
          headline: `Research completed: ${summary}`,
          body: completionBody(reference, evidence),
          dedup_key: `task-complete:${reference}`,
        }],
      }).then(() => true, err => {
        log(`completion for ${reference} could not be committed: ${errorText(err) ?? "unknown error"}`);
        return false;
      });
      if (committed) onAlerts();
      return { open: !committed };
    }

    const reason = errorText(fact.error) ?? status;
    const state: RunState = status;
    const alert: AlertInput = {
      kind: "failure",
      headline: status === "failed" ? `Research failed: ${oneLine(reason, 120)}` : "Research was cancelled",
      body: `Run ${reference} ended as ${status}${reason && reason !== status ? `: ${reason}` : ""}. Read what it stored with web_recall { reference: "${reference}" }.`,
      dedup_key: `task-${state}:${reference}`,
    };
    const committed = await store.completeRun({
      sessionId, reference, state: status,
      error: reason,
      providerRunId,
      providerInteractionId: interactionId,
      rawResult: { run: fact.run },
      alerts: [alert],
    }).then(() => true, err => {
      log(`terminal state for ${reference} could not be committed: ${errorText(err) ?? "unknown error"}`);
      return false;
    });
    if (committed) onAlerts();
    return { open: !committed };
  }

  async function latestStateEvent(reference: string): Promise<unknown> {
    return (await store.latestObservations(sessionId, reference, { eventType: "task_run.state", limit: 1 }))[0]?.payload;
  }

  /** Queue due progress alerts and advance their schedules. Returns how many were queued. */
  async function tick(): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    let queued = 0;
    try {
      for (const run of await store.runsNeedingProgress(sessionId)) {
        const intervalMs = run.alert_interval_ms ?? intervalFor(run.processor);
        const processor = run.processor ?? TASK_FLOOR;
        const latest = await latestProgress(run.reference);
        const queuedOne = await store.queueProgress(sessionId, run.reference, {
          kind: "progress",
          headline: latest.sources !== undefined
            ? `Research still running (${processor}): ${latest.sources} source(s) considered`
            : `Research still running (${processor})`,
          body: [
            latest.finding
              ? `Latest finding: ${oneLine(latest.finding, 220)}`
              : latest.message ? `Latest activity: ${oneLine(latest.message, 220)}` : "No new details yet; the run is still active.",
            `Partial evidence so far: web_recall { reference: "${run.reference}" }.`,
          ].join(" "),
          dedup_key: `task-progress:${run.reference}:${Math.floor(store.now() / intervalMs)}`,
        });
        if (queuedOne) queued++;
      }
      if (queued) onAlerts();
      return queued;
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

  return { bound, observed, tick };
}

export type TaskRunLifecycle = ReturnType<typeof createTaskRunLifecycle>;

function completionBody(reference: string, evidence: EvidenceInput[]): string {
  const sources = evidence.filter(item => item.kind === "source").length;
  const fields = evidence.filter(item => item.kind === "structured").length;
  const parts = [sources ? `${sources} cited source(s)` : undefined, fields ? `${fields} structured field(s)` : undefined].filter(Boolean);
  return [
    `Run ${reference} completed${parts.length ? ` with ${parts.join(" and ")}` : ""}.`,
    `Read the report with web_recall { reference: "${reference}" }, or read one item by handle.`,
  ].join(" ");
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
