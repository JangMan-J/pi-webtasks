/**
 * Cited answers through the Responses API (`POST /v1/responses`), delivered
 * asynchronously: the tool call records the run and returns its reference, a
 * background sidecar consumes the response's event stream, and the finished
 * answer arrives as an alert.
 *
 * The pinned SDK has no Responses resource, so this module issues the documented
 * raw request as a recorded paid call (`paid-call.ts`): sent once with
 * `stream: true`, never retried. The API has no native background mode and no
 * retrieve-by-id, so an answer whose stream is interrupted settles as
 * `uncertain` rather than being repeated or guessed.
 *
 * The sidecar settles the run exactly once, committing evidence, citations, and
 * the completion or failure alert in one store transaction. `stop()` aborts
 * every in-flight stream before the store closes under it.
 */

import type { CitationInput, EvidenceInput, ResearchStore, RunRecord } from "./store.ts";
import { TERMINAL_RUN_STATES } from "./store.ts";
import { createPaidCalls } from "./paid-call.ts";
import { sourcePolicy } from "./source-policy.ts";
import { clean, errorText, oneLine, RECEIPT_LIMIT, replayReceipt } from "./receipt.ts";
import type { WebtasksStatus } from "./status.ts";

/** The part of the Parallel client the answer path needs. */
export type AnswerClient = {
  apiKey?: string;
  post(path: string, options?: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    maxRetries?: number;
    timeout?: number;
    signal?: AbortSignal;
    /** SDK request option: resolve at the response headers with an async iterable of parsed SSE data payloads. */
    stream?: boolean;
  }): Promise<unknown>;
};

export type AnswerInput = {
  question: string;
  effort?: "low" | "medium" | "high";
  instructions?: string;
  include_domains?: string[];
  exclude_domains?: string[];
  /** Local reference of an earlier answer to continue. */
  continue_from?: string;
};

export const ANSWER_EFFORTS = ["low", "medium", "high"] as const;
/** Parallel's own default; low suits only a fact one good source settles. */
export const DEFAULT_ANSWER_EFFORT: (typeof ANSWER_EFFORTS)[number] = "medium";

export type AnswerReceipt = { text: string; details: Record<string, unknown> };

type Options = {
  store: ResearchStore;
  sessionId: string;
  client: () => Promise<AnswerClient>;
  /** Alerts were committed: wake the delivery. */
  onAlerts?: () => void;
  /** Footer status: the answer lane stays busy until the sidecar settles, not until the tool call returns. */
  status?: () => WebtasksStatus | undefined;
  log?: (message: string) => void;
  /** Overall bound for one answer stream, so a hung connection never pins the runtime. */
  streamTimeoutMs?: number;
};

type CrossSessionRunLookup = {
  run(sessionId: string, reference: string, options?: { crossSession?: boolean }): Promise<RunRecord | undefined>;
};

type Annotation = { type?: string; url?: string; title?: string; start_index?: number; end_index?: number };

/** Default overall bound for one answer stream. */
const STREAM_TIMEOUT_MS = 600_000;
/** Answer characters the completion alert carries before it points at web_recall. */
const ALERT_PREVIEW = 1500;

/** Read the answer text: `output_text` when present, otherwise the message items. */
function answerText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const output = response.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
  }
  return parts.join("\n");
}

function annotations(response: Record<string, unknown>): Annotation[] {
  const output = response.output;
  if (!Array.isArray(output)) return [];
  const found: Annotation[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const list = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(list)) continue;
      for (const annotation of list) {
        if (annotation && typeof annotation === "object" && (annotation as Annotation).type === "url_citation") {
          found.push(annotation as Annotation);
        }
      }
    }
  }
  return found;
}

function evidenceFromAnswer(text: string, list: Annotation[]): { evidence: EvidenceInput[]; citations: CitationInput[] } {
  const evidence: EvidenceInput[] = [{
    kind: "report",
    origin: "provider_report",
    title: "Cited answer",
    body: text,
    pointer: "output_text",
    ref: "answer",
  }];
  const citations: CitationInput[] = [];
  const seen = new Map<string, string>();
  for (const annotation of list) {
    const url = clean(annotation.url);
    if (!url) continue;
    let ref = seen.get(url);
    if (!ref) {
      ref = `src:${seen.size}`;
      seen.set(url, ref);
      evidence.push({
        kind: "source",
        origin: "provider_source",
        title: clean(annotation.title),
        url,
        pointer: "annotations",
        body: url,
        payload: annotation,
        ref,
      });
    }
    const start = typeof annotation.start_index === "number" ? annotation.start_index : undefined;
    const end = typeof annotation.end_index === "number" ? annotation.end_index : undefined;
    const claim = start !== undefined && end !== undefined && end > start ? text.slice(start, end) : undefined;
    citations.push({ evidence: "answer", source: ref, url, title: clean(annotation.title), claim: claim ? oneLine(claim, 300) : undefined });
  }
  return { evidence, citations };
}

/** Unique source hosts in citation order, for the completion alert. */
function sourceHosts(citations: CitationInput[]): string[] {
  const hosts: string[] = [];
  for (const citation of citations) {
    if (!citation.url) continue;
    let host: string | undefined;
    try {
      host = new URL(citation.url).hostname;
    } catch {
      host = undefined;
    }
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

export function createAnswerService(options: Options) {
  const { store, sessionId } = options;
  const log = options.log ?? (() => undefined);
  const calls = createPaidCalls({ store, sessionId, client: options.client });
  /** In-flight answer streams, by run reference. */
  const active = new Map<string, AbortController>();
  const collecting = new Set<Promise<void>>();
  let stopping = false;

  async function continuationId(reference: string): Promise<string> {
    const run = await (store as ResearchStore & CrossSessionRunLookup).run(sessionId, reference, { crossSession: true });
    if (!run) throw new Error(`${reference} is not a research record`);
    if (run.kind !== "answer") throw new Error(`${reference} is not an earlier web_answer; continue a web_research run with web_research { continue_from }`);
    if (run.state !== "completed" || !run.provider_run_id) throw new Error(`${reference} has no completed answer to continue from (state: ${run.state})`);
    return run.provider_run_id;
  }

  async function answer(input: AnswerInput, call: { invocationId: string; signal?: AbortSignal }): Promise<AnswerReceipt> {
    const question = clean(input.question);
    if (!question) throw new Error("question must be a non-empty string");
    const effort = input.effort ?? DEFAULT_ANSWER_EFFORT;
    if (!(ANSWER_EFFORTS as readonly string[]).includes(effort)) throw new Error("effort must be low, medium, or high");
    const previous = input.continue_from ? await continuationId(clean(input.continue_from)!) : undefined;
    const { include, exclude } = sourcePolicy(input);
    if (include.length && exclude.length) {
      throw new Error("web_answer takes include_domains or exclude_domains, not both: Parallel applies only the allow list when both are sent");
    }

    const intent = {
      kind: "answer" as const,
      question,
      effort,
      instructions: clean(input.instructions),
      include_domains: include,
      exclude_domains: exclude,
      continue_from: clean(input.continue_from),
    };
    const body: Record<string, unknown> = {
      model: "parallel",
      input: question,
      stream: true,
      reasoning: { effort },
      ...(previous ? { previous_response_id: previous } : {}),
      ...(clean(input.instructions) ? { instructions: clean(input.instructions) } : {}),
      ...(include.length || exclude.length
        ? { tools: [{ type: "web_search", filters: include.length ? { allowed_domains: include } : { blocked_domains: exclude } }] }
        : {}),
    };

    const outcome = await calls.run({
      kind: "answer",
      label: "Answer",
      intent,
      invocation: call,
      uncertainAdvice: reference => `Its outcome is unknown (record ${reference}); ask again only if you still need the answer.`,
      send: async (parallel, { reference, options: request }) => {
        const controller = new AbortController();
        active.set(reference, controller);
        let result: unknown;
        try {
          result = await parallel.post("/v1/responses", {
            body,
            headers: { Accept: "text/event-stream", ...(parallel.apiKey ? { Authorization: `Bearer ${parallel.apiKey}` } : {}) },
            stream: true,
            // The invocation signal is deliberately not forwarded: the SDK links it to the
            // fetch for its whole life, and the background stream must outlive the tool call.
            signal: controller.signal,
            maxRetries: 0,
            timeout: request.timeout,
          });
        } catch (err) {
          active.delete(reference);
          throw err;
        }
        launch(reference, result, controller, options.status?.()?.begin("answer"));
        return { opened: true };
      },
    });

    if (outcome.replayed) {
      const { reference, run, hits } = outcome;
      const first = hits.find(hit => hit.kind === "report") ?? hits[0];
      // The stored answer is the body; leave room for the header and footer within the receipt budget.
      const stored = first ? (await store.readEvidence(sessionId, first.handle, { limit: RECEIPT_LIMIT - 800 })).text : "";
      const { text, details } = replayReceipt({ noun: "question", reference, state: run?.state ?? "unknown", hits, body: stored ? [stored] : [], listHits: !stored });
      return { text, details: { ...details, handle: first?.handle } };
    }

    const { reference } = outcome;
    return {
      text: [
        `Answer running in the background: ${reference} (${effort} effort).`,
        "The cited answer arrives as a follow-up message, even after you end your turn; there is nothing to poll.",
        "Keep working meanwhile. When nothing else is left, end your turn; the answer alert brings you back.",
        `Once it completes, read it with web_recall { reference: "${reference}" }, or follow up with web_answer { question, continue_from: "${reference}" }.`,
      ].join("\n"),
      details: { reference, state: "submitted", replayed: false, effort, continued: previous !== undefined },
    };
  }

  /** Run the sidecar; it settles the run and always ends the status lane. */
  function launch(reference: string, result: unknown, controller: AbortController, endStatus?: () => void): void {
    const work: Promise<void> = consume(reference, result, controller)
      .catch((err: unknown) => log(`answer ${reference} sidecar failed: ${errorText(err) ?? "unknown error"}`))
      .finally(() => {
        endStatus?.();
        active.delete(reference);
        collecting.delete(work);
      });
    collecting.add(work);
  }

  /** Consume the opened response: an SSE event stream, or a direct Response object from a non-streaming server. */
  async function consume(reference: string, result: unknown, controller: AbortController): Promise<void> {
    const timeoutMs = options.streamTimeoutMs ?? STREAM_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        // Each item is the parsed `data:` payload of one SSE message; the event name is its `type`.
        let terminal: Record<string, unknown> | undefined;
        let deltas = "";
        let textDone: string | undefined;
        const noted: Annotation[] = [];
        let bound = false;
        for await (const event of result as AsyncIterable<Record<string, unknown>>) {
          if (controller.signal.aborted) break;
          const type = typeof event?.type === "string" ? event.type : "";
          if (type === "response.created" || type === "response.in_progress") {
            const id = (event.response as { id?: unknown } | undefined)?.id;
            if (!bound && typeof id === "string" && id) {
              bound = true;
              await store.bindProviderRun({ sessionId, reference, providerRunId: id })
                .catch((err: unknown) => log(`binding ${id} for ${reference} failed: ${errorText(err) ?? "unknown error"}`));
            }
          } else if (type === "response.output_text.delta") {
            if (typeof event.delta === "string") deltas += event.delta;
          } else if (type === "response.output_text.annotation.added") {
            if (event.annotation && typeof event.annotation === "object") noted.push(event.annotation as Annotation);
          } else if (type === "response.output_text.done") {
            if (typeof event.text === "string") textDone = event.text;
          } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
            terminal = (event.response && typeof event.response === "object" ? event.response : {}) as Record<string, unknown>;
            break;
          }
        }
        if (!terminal) {
          if (controller.signal.aborted && !timedOut) {
            await settleUncertain(reference, "interrupted before the result was stored");
          } else if (timedOut) {
            await settleUncertain(reference, `the answer stream exceeded ${Math.round(timeoutMs / 1000)}s and was stopped; its outcome is unknown`);
          } else {
            await settleUncertain(reference, "the response stream ended before Parallel sent a terminal event; its outcome is unknown (Parallel has no GET /v1/responses/{id} to reconcile it)");
          }
          return;
        }
        await settleTerminal(reference, terminal, { text: textDone ?? deltas, annotations: noted });
      } else {
        // A mock or non-streaming server answered application/json directly.
        await settleTerminal(reference, (result && typeof result === "object" ? result : {}) as Record<string, unknown>, undefined);
      }
    } catch (err) {
      await settleUncertain(reference, controller.signal.aborted ? "interrupted before the result was stored" : (errorText(err, 300) ?? "unknown error"));
    } finally {
      clearTimeout(timer);
    }
  }

  /** An interrupted answer can never be reconciled (no retrieve-by-id): say so honestly. Never throws. */
  async function settleUncertain(reference: string, reason: string): Promise<void> {
    try {
      const run = await store.run(sessionId, reference);
      if (!run || TERMINAL_RUN_STATES.has(run.state)) return;
      await store.setRunState({ sessionId, reference, state: "uncertain", error: reason });
    } catch {
      /* best effort: the store may be closing */
    }
  }

  /** Settle a finished response exactly once; a terminal run is never moved. */
  async function settleTerminal(reference: string, response: Record<string, unknown>, fallback?: { text: string; annotations: Annotation[] }): Promise<void> {
    let run: RunRecord | undefined;
    try {
      run = await store.run(sessionId, reference);
    } catch {
      return; // the store is closing; nothing more to record
    }
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return;

    const status = typeof response.status === "string" ? response.status : "completed";
    if (status === "completed") {
      const id = typeof response.id === "string" ? response.id : undefined;
      if (!id) {
        await settleUncertain(reference, "response carried no id");
        return;
      }
      const text = answerText(response) || fallback?.text || "";
      if (!text.trim()) {
        await settleFailed(reference, "failed", {
          error: "response carried no answer text",
          headline: "Answer failed: the answer came back empty",
          body: `Answer ${reference} ended as failed: the answer came back empty. Anything it stored is at web_recall { reference: "${reference}" }.`,
          raw: response,
        });
        return;
      }
      const found = annotations(response);
      const { evidence, citations } = evidenceFromAnswer(text, found.length ? found : (fallback?.annotations ?? []));
      const hosts = sourceHosts(citations);
      const preview = text.length <= ALERT_PREVIEW ? text : `${text.slice(0, ALERT_PREVIEW)}\n\n[Answer continues; read the rest with web_recall { reference: "${reference}" }]`;
      const committed = await store.completeRun({
        sessionId, reference, state: "completed", summary: oneLine(text, 120),
        providerRunId: id, rawResult: response, evidence, citations,
        alerts: [{
          kind: "completion",
          headline: `Answer ready: ${oneLine(text, 120)}`,
          body: `${preview}\n\nCitations: ${citations.length} source link(s) across ${hosts.length} site(s)${hosts.length ? ` (top: ${hosts.slice(0, 3).join(", ")})` : ""}. Answer ${reference}.\nRead it with web_recall { reference: "${reference}" }; follow up with web_answer { question, continue_from: "${reference}" }.`,
          dedup_key: `answer-complete:${reference}`,
        }],
      }).then(() => true, (err: unknown) => {
        log(`completion for ${reference} could not be committed: ${errorText(err) ?? "unknown error"}`);
        return false;
      });
      if (committed) options.onAlerts?.();
      return;
    }
    if (status === "incomplete") {
      const details = response.incomplete_details as { reason?: unknown } | undefined;
      const reason = typeof details?.reason === "string" ? details.reason : "no reason given";
      const text = answerText(response) || fallback?.text || "";
      const found = annotations(response);
      const partial = text.trim() ? evidenceFromAnswer(text, found.length ? found : (fallback?.annotations ?? [])) : undefined;
      await settleFailed(reference, "failed", {
        error: `incomplete: ${reason}`,
        headline: `Answer incomplete: ${oneLine(reason, 120)}`,
        body: `Answer ${reference} ended incomplete: ${reason}. Anything it stored is at web_recall { reference: "${reference}" }.${partial ? " A partial answer is stored under the reference." : ""}`,
        evidence: partial?.evidence,
        citations: partial?.citations,
        raw: response,
      });
      return;
    }
    if (status === "cancelled") {
      const reason = errorText(response.error, 300) ?? "cancelled";
      await settleFailed(reference, "cancelled", {
        error: reason,
        headline: "Answer was cancelled",
        body: `Answer ${reference} was cancelled. Anything it stored is at web_recall { reference: "${reference}" }.`,
        raw: response,
      });
      return;
    }
    if (status === "failed") {
      const reason = errorText(response.error, 300) ?? "no reason given";
      await settleFailed(reference, "failed", {
        error: reason,
        headline: `Answer failed: ${oneLine(reason, 120)}`,
        body: `Answer ${reference} ended as failed: ${reason}. Anything it stored is at web_recall { reference: "${reference}" }.`,
        raw: response,
      });
      return;
    }
    await settleUncertain(reference, `the response ended with status ${status}`);
  }

  /** Commit a failed or cancelled answer with its alert in one transaction. Never throws. */
  async function settleFailed(reference: string, state: "failed" | "cancelled", input: {
    error: string;
    headline: string;
    body: string;
    evidence?: EvidenceInput[];
    citations?: CitationInput[];
    raw?: unknown;
  }): Promise<void> {
    const committed = await store.completeRun({
      sessionId, reference, state, error: input.error,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.citations ? { citations: input.citations } : {}),
      rawResult: input.raw,
      alerts: [{ kind: "failure", headline: input.headline, body: input.body, dedup_key: `answer-${state}:${reference}` }],
    }).then(() => true, (err: unknown) => {
      log(`settling ${reference} as ${state} failed: ${errorText(err) ?? "unknown error"}`);
      return false;
    });
    if (committed) options.onAlerts?.();
  }

  /** Abort in-flight answer streams and let their settlement unwind before the store closes. */
  async function stop(): Promise<void> {
    stopping = true;
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled([...collecting]);
    active.clear();
  }

  return { answer, stop };
}

export type AnswerService = ReturnType<typeof createAnswerService>;
