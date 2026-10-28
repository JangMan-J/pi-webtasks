/**
 * The recorded paid call: one request to Parallel that costs money, recorded
 * before it is sent and settled exactly once.
 *
 * Every paid tool goes through here (web_search, web_fetch, web_answer, and the
 * web_research submission), so these rules hold in one place:
 *
 *  - Intent before money: the run is recorded, keyed by the Pi tool invocation,
 *    before the request. A replayed invocation returns the stored run and is
 *    never sent again.
 *  - A missing or unusable credential is a local failure: the provider was never
 *    asked, so the run is `failed` and the original, actionable message is kept.
 *  - The request is sent once and never retried (`maxRetries: 0`).
 *  - A 4xx response is a definite rejection: `failed`. Anything else (5xx, 408,
 *    a lost connection, a timeout, an abort, an unexpected error once the
 *    request was under way) may have reached the provider, so the run is
 *    `uncertain` and is never silently resubmitted.
 *  - A usable response is committed with its evidence and citations in one
 *    store transaction. A response that arrived but cannot be used settles the
 *    run as the caller says (`UnusableResponse`).
 *  - A call without `settle` hands the accepted run off (Task research): the run
 *    keeps the state that `send` recorded, and collection settles it later.
 *
 * The caller owns what varies: input validation, the request, how a response
 * becomes evidence, and the wording of its receipt.
 */

import type { CitationInput, EvidenceInput, EvidenceKind, ResearchStore, RunKind, RunRecord, SearchHit } from "./store.ts";

/** Upper bound for one synchronous paid request. */
export const REQUEST_TIMEOUT_MS = 180_000;
/** Stored evidence listed for a replayed invocation. */
const REPLAY_HITS = 20;

/** Options every paid request is sent with. */
export type RequestOptions = { signal?: AbortSignal; maxRetries: 0; timeout: number };

/** What a usable response stores, committed in one transaction with the completed state. */
export type Settlement = {
  summary: string;
  evidence?: EvidenceInput[];
  citations?: CitationInput[];
  /** Provider operation id (search id, extract id, response id). */
  providerRunId?: string;
  /** Provider research context (Search/Extract session id). */
  providerSessionId?: string;
  /** Provider interaction id, for a later continuation. */
  providerInteractionId?: string;
  /** Untouched provider response, stored verbatim. */
  rawResult: unknown;
};

export type PaidCall<C, R> = {
  kind: RunKind;
  /** Names the call in errors: "Search", "Fetch", "Answer", "Research submission". */
  label: string;
  /** The effective request, recorded before it is sent. */
  intent: Record<string, unknown>;
  processor?: string;
  /** The Pi tool invocation: its id keys the record, its signal may abort the request. */
  invocation: { invocationId: string; signal?: AbortSignal };
  /** The one paid request. It is never retried; `reference` names the local record. */
  send(client: C, request: { reference: string; options: RequestOptions }): Promise<R>;
  /** What a usable response stores. Omit it to hand the accepted run off to collection. */
  settle?(response: R, reference: string): Settlement;
  /** The advice after an outcome-unknown failure. Default: try again only if the result is still needed. */
  uncertainAdvice?(reference: string): string;
};

export type PaidOutcome<R> =
  | {
    replayed: true;
    reference: string;
    /** The stored run; absent only if it vanished between the lookup and the read. */
    run?: RunRecord;
    /** Evidence already stored for it, newest first. */
    hits: SearchHit[];
  }
  | {
    replayed: false;
    reference: string;
    response: R;
    /** Handles of the evidence committed by `settle`, in the order given; empty for a hand-off. */
    evidence: { handle: string; kind: EvidenceKind; title?: string }[];
  };

/**
 * Thrown by `settle` when a response arrived but cannot be used. The run is
 * settled as `state` with `reason` recorded, and the agent sees `message`.
 */
export class UnusableResponse extends Error {
  readonly state: "failed" | "uncertain";
  readonly reason: string;
  constructor(state: "failed" | "uncertain", reason: string, message: string) {
    super(message);
    this.name = "UnusableResponse";
    this.state = state;
    this.reason = reason;
  }
}

/** A 4xx response is a definite rejection; anything else may have reached the provider. */
export function outcomeUnknown(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status >= 500 || status === 408 : true;
}

/** Longest failure message recorded or shown; provider error bodies can be large. */
const MESSAGE_LIMIT = 500;

/** The readable message of a failure, on one bounded line. */
export function failureMessage(err: unknown): string {
  let text: string;
  if (err instanceof Error) text = err.message;
  else if (typeof err === "string") text = err;
  else {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    try {
      text = typeof message === "string" ? message : JSON.stringify(err) ?? String(err);
    } catch {
      text = String(err);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim() || "unknown error";
  return flat.length <= MESSAGE_LIMIT ? flat : `${flat.slice(0, MESSAGE_LIMIT - 1)}…`;
}

function defaultAdvice(reference: string): string {
  return `Its outcome is unknown (record ${reference}); try again only if you still need the result.`;
}

/** Paid calls for one Pi session: one store, one session id, one provider client factory. */
export function createPaidCalls<C>(options: { store: ResearchStore; sessionId: string; client: () => Promise<C> }) {
  const { store, sessionId } = options;

  /** Best effort: a store that cannot record the outcome must not hide the original error. */
  async function settleAs(reference: string, state: "failed" | "uncertain", error: string): Promise<void> {
    await store.setRunState({ sessionId, reference, state, error }).catch(() => undefined);
  }

  async function run<R>(call: PaidCall<C, R>): Promise<PaidOutcome<R>> {
    const begun = await store.beginRun({
      sessionId,
      intentKey: call.invocation.invocationId,
      intent: call.intent,
      kind: call.kind,
      processor: call.processor,
      state: "submitting",
    });
    const reference = begun.reference;
    if (!begun.created) {
      const stored = await store.run(sessionId, reference);
      const page = await store.search(sessionId, { reference, limit: REPLAY_HITS });
      return { replayed: true, reference, run: stored, hits: page.hits };
    }

    let client: C;
    try {
      client = await options.client();
    } catch (err) {
      await settleAs(reference, "failed", failureMessage(err));
      throw err;
    }

    let response: R;
    try {
      response = await call.send(client, {
        reference,
        options: { signal: call.invocation.signal, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS },
      });
    } catch (err) {
      const uncertain = outcomeUnknown(err);
      const message = failureMessage(err);
      await settleAs(reference, uncertain ? "uncertain" : "failed", message);
      throw new Error(
        `${call.label} did not complete: ${message}. ${uncertain ? (call.uncertainAdvice ?? defaultAdvice)(reference) : `Record ${reference}.`}`,
      );
    }

    if (!call.settle) return { replayed: false, reference, response, evidence: [] };
    try {
      const settlement = call.settle(response, reference);
      const completion = await store.completeRun({ sessionId, reference, state: "completed", ...settlement });
      return { replayed: false, reference, response, evidence: completion.evidence };
    } catch (err) {
      // The provider answered, so nothing here may claim the request failed outright,
      // unless the caller judged the response itself.
      if (err instanceof UnusableResponse) {
        await settleAs(reference, err.state, err.reason);
        throw err;
      }
      const message = failureMessage(err);
      await settleAs(reference, "uncertain", `the response could not be stored: ${message}`);
      // Say that it ran: an agent that reads a bare storage error would pay for it again.
      throw new Error(
        `${call.label} ran, but its result could not be stored: ${message}. Record ${reference} is uncertain; repeat the request only if you still need the result.`,
        { cause: err },
      );
    }
  }

  return { run };
}

export type PaidCalls<C> = ReturnType<typeof createPaidCalls<C>>;
