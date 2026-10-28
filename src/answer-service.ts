/**
 * Cited answers through the Responses API (`POST /v1/responses`), with local
 * continuation and stored evidence.
 *
 * The pinned SDK has no Responses resource, so this module issues the documented
 * raw request as a recorded paid call (`paid-call.ts`): never retried, because
 * the API has no native background mode or retrieve-by-id, so an ambiguous
 * outcome is recorded as `uncertain` rather than repeated.
 */

import type { ResearchStore, EvidenceInput, CitationInput } from "./store.ts";
import { createPaidCalls, UnusableResponse } from "./paid-call.ts";
import { sourcePolicy } from "./source-policy.ts";
import { clean, oneLine, RECEIPT_LIMIT, replayReceipt, UNTRUSTED } from "./receipt.ts";

/** The part of the Parallel client the answer path needs. */
export type AnswerClient = {
  apiKey?: string;
  post(path: string, options?: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    maxRetries?: number;
    timeout?: number;
    signal?: AbortSignal;
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
};

type Annotation = { type?: string; url?: string; title?: string; start_index?: number; end_index?: number };

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

/** The answer text for the receipt, cut at the budget with a pointer to the rest. */
function answerPreview(text: string, limit = RECEIPT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n\n[Answer continues; read the rest with web_recall { handle }]`, truncated: true };
}

export function createAnswerService({ store, sessionId, client }: Options) {
  const calls = createPaidCalls({ store, sessionId, client });

  async function continuationId(reference: string): Promise<string> {
    const run = await store.run(sessionId, reference);
    if (!run) throw new Error(`${reference} is not a research record in this session`);
    if (run.kind !== "answer") throw new Error(`${reference} is not an earlier web_answer; continue a web_research run with web_research { continue_from }`);
    if (!run.provider_run_id) throw new Error(`${reference} has no completed answer to continue from (state: ${run.state})`);
    return run.provider_run_id;
  }

  async function answer(input: AnswerInput, call: { invocationId: string; signal?: AbortSignal }): Promise<AnswerReceipt> {
    const question = clean(input.question);
    if (!question) throw new Error("question must be a non-empty string");
    const effort = input.effort ?? DEFAULT_ANSWER_EFFORT;
    if (!(ANSWER_EFFORTS as readonly string[]).includes(effort)) throw new Error("effort must be low, medium, or high");
    const previous = input.continue_from ? await continuationId(clean(input.continue_from)!) : undefined;
    const { include, exclude } = sourcePolicy(input);

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
      reasoning: { effort },
      ...(previous ? { previous_response_id: previous } : {}),
      ...(clean(input.instructions) ? { instructions: clean(input.instructions) } : {}),
      ...(include.length || exclude.length
        ? { tools: [{ type: "web_search", filters: { allowed_domains: include, blocked_domains: exclude } }] }
        : {}),
    };

    const outcome = await calls.run({
      kind: "answer",
      label: "Answer",
      intent,
      invocation: call,
      uncertainAdvice: reference => `Its outcome is unknown (record ${reference}); ask again only if you still need the answer.`,
      send: async (parallel, { options }) => await parallel.post("/v1/responses", {
        body,
        ...(parallel.apiKey ? { headers: { Authorization: `Bearer ${parallel.apiKey}` } } : {}),
        ...options,
      }) as Record<string, unknown>,
      settle: (response, reference) => {
        const id = typeof response.id === "string" ? response.id : undefined;
        if (!id) {
          throw new UnusableResponse("uncertain", "response carried no id", `The answer came back incomplete (record ${reference}); ask again if you still need it.`);
        }
        const text = answerText(response);
        if (!text.trim()) {
          throw new UnusableResponse("failed", "response carried no answer text", `The answer came back empty (record ${reference}).`);
        }
        const { evidence, citations } = evidenceFromAnswer(text, annotations(response));
        return { summary: oneLine(text, 120), providerRunId: id, rawResult: response, evidence, citations };
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

    const { reference, settlement } = outcome;
    const text = settlement?.evidence?.find(item => item.kind === "report")?.body ?? "";
    const citations = settlement?.citations ?? [];
    const report = outcome.evidence.find(item => item.kind === "report")?.handle;
    const preview = answerPreview(text);
    return {
      text: [
        preview.text,
        "",
        `Citations: ${citations.length} source link(s). Full answer: ${reference}.`,
        `Ask a follow-up with web_answer { question, continue_from: "${reference}" }.`,
        report ? `Read the stored answer with web_recall { handle: "${report}" }.` : undefined,
        UNTRUSTED,
      ].filter((line): line is string => line !== undefined).join("\n"),
      details: {
        reference,
        handle: report,
        sources: citations.length,
        truncated: preview.truncated,
        effort,
        continued: previous !== undefined,
      },
    };
  }

  return { answer };
}

export type AnswerService = ReturnType<typeof createAnswerService>;
