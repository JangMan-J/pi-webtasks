/**
 * Check: Parallel decisions (`POST /v1/decisions`, fast mode) about one state,
 * stored as session-owned evidence.
 *
 * Verdicts and the web sources behind them are kept in the local store; the
 * model sees a bounded receipt with stable handles. Recording, replay, the
 * single retry-free request, and failed-versus-uncertain settlement are the
 * recorded paid call's rules (`paid-call.ts`). The provider decision id stays
 * in the store.
 */

import type { EvidenceInput, ResearchStore, CitationInput } from "./store.ts";
import { createPaidCalls, UnusableResponse, type PaidCalls } from "./paid-call.ts";
import { bounded, replayReceipt, UNTRUSTED } from "./receipt.ts";

/** The subset of the Parallel client this module uses, so tests can supply a fake. */
export type CheckClient = {
  post(path: string, options?: { body?: Record<string, unknown>; maxRetries?: number; timeout?: number; signal?: AbortSignal }): Promise<unknown>;
};

export type CheckQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type CheckInput = { state: unknown; questions: Record<string, CheckQuestion>; after_date?: string; location?: string };
export type CheckReceipt = { text: string; details: Record<string, unknown> };

const KEY = /^[A-Za-z0-9_-]+$/;
const OMITTED = "the verdicts and sources are all stored";
const MAX_SOURCES_SHOWN = 5;

type Answer = {
  type?: string;
  noul?: unknown;
  choice?: unknown;
  probabilities?: Record<string, unknown>;
  score?: unknown;
  legend?: Record<string, unknown>;
  confidence?: unknown;
};
type Citation = { url: string; title?: string | null; excerpts?: unknown };

/** Strict `YYYY-MM-DD`: the date must exist on the calendar. */
export function calendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return value;
  }
  throw new Error(`after_date must be a real calendar date written YYYY-MM-DD, got "${value}"`);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateState(state: unknown): void {
  const ok = typeof state === "string"
    ? state.trim().length > 0
    : Array.isArray(state) ? state.length > 0 : isPlain(state) && Object.keys(state).length > 0;
  if (!ok) throw new Error("state must be a non-empty string, object, or array describing the situation to decide about");
}

function noUnknown(key: string, question: Record<string, unknown>): void {
  for (const field of Object.keys(question)) {
    if (field !== "type" && field !== "instructions" && field !== "criteria") {
      throw new Error(`question "${key}" has unknown field "${field}"; use type, instructions, and criteria`);
    }
  }
}

function validateQuestion(key: string, question: unknown): void {
  if (!isPlain(question)) throw new Error(`question "${key}" must be an object with type and instructions`);
  noUnknown(key, question);
  const { type, instructions, criteria } = question;
  if (type !== "noul" && type !== "choice" && type !== "score") {
    throw new Error(`question "${key}" needs type "noul", "choice", or "score"`);
  }
  if (!text(instructions)) throw new Error(`question "${key}" needs non-empty instructions`);
  if (type === "noul") {
    if (criteria === undefined) return;
    if (!isPlain(criteria) || !text(criteria.true) || !text(criteria.false) || Object.keys(criteria).length !== 2) {
      throw new Error(`question "${key}": noul criteria, when given, needs non-empty "true" and "false" descriptions`);
    }
  } else if (type === "choice") {
    const entries = isPlain(criteria) ? Object.entries(criteria) : [];
    if (entries.length < 2 || entries.length > 255 || entries.some(([option, description]) => !option.trim() || !text(description))) {
      throw new Error(`question "${key}": choice criteria needs 2-255 options, each with a non-empty description`);
    }
  } else if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(text)) {
    throw new Error(`question "${key}": score criteria needs 2-10 non-empty level descriptions, ordered from level 0`);
  }
}

function validateQuestions(questions: unknown): string[] {
  if (!isPlain(questions)) throw new Error("questions must be an object keyed by question name");
  const keys = Object.keys(questions);
  if (keys.length < 1 || keys.length > 100) throw new Error("questions needs 1-100 entries");
  for (const key of keys) {
    if (!KEY.test(key)) throw new Error(`question key "${key}" may only use letters, digits, "_" and "-"`);
    validateQuestion(key, questions[key]);
  }
  return keys;
}

const num = (value: unknown): string => (typeof value === "number" ? value.toFixed(2) : "?");

function confidenceText(answer: Answer): string {
  return typeof answer.confidence === "number" ? `confidence ${num(answer.confidence)}` : "";
}

/** One verdict line for an asked question. */
function verdictLine(key: string, question: CheckQuestion, answer: Answer | undefined): string {
  if (!isPlain(answer)) return `${key}: no answer returned`;
  if (answer.type === "refusal") return `${key} (refusal): the provider declined to answer`;
  const confidence = confidenceText(answer);
  if (answer.type === "noul") return `${key} (noul): ${num(answer.noul)} probability true`;
  if (answer.type === "choice") {
    const p = typeof answer.choice === "string" ? answer.probabilities?.[answer.choice] : undefined;
    const parts = [`p ${num(p)}`, confidence].filter(Boolean).join(", ");
    return `${key} (choice): ${String(answer.choice)} (${parts})`;
  }
  if (answer.type === "score") {
    const levels = question.type === "score" ? question.criteria.length : Object.keys(answer.legend ?? {}).length;
    const score = typeof answer.score === "number" ? answer.score : Number.NaN;
    const level = Number.isNaN(score) ? 0 : Math.min(Math.max(Math.round(score), 0), Math.max(levels - 1, 0));
    const legend = answer.legend?.[String(level)] ?? (question.type === "score" ? question.criteria[level] : undefined);
    const tail = confidence ? ` (${confidence})` : "";
    return `${key} (score): ${num(answer.score)} on 0-${Math.max(levels - 1, 0)}, nearest level ${level} "${String(legend ?? "")}"${tail}`;
  }
  return `${key}: no answer returned`;
}

function answerDetail(answer: Answer | undefined): Record<string, unknown> {
  if (!isPlain(answer)) return { type: "none" };
  const detail: Record<string, unknown> = { type: answer.type };
  if (answer.type === "noul") detail.noul = answer.noul;
  if (answer.type === "choice") detail.choice = answer.choice;
  if (answer.type === "score") detail.score = answer.score;
  if (typeof answer.confidence === "number") detail.confidence = answer.confidence;
  return detail;
}

/** Citations with a url, first occurrence of each url only. */
function uniqueCitations(citations: unknown[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const item of citations) {
    if (!isPlain(item) || typeof item.url !== "string" || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item as Citation);
  }
  return out;
}

function host(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

type Response = { answers?: unknown; citations?: unknown; decision_id?: unknown };

class Service {
  private readonly calls: PaidCalls<CheckClient>;

  constructor(options: { store: ResearchStore; sessionId: string; client: () => Promise<CheckClient> }) {
    this.calls = createPaidCalls({ store: options.store, sessionId: options.sessionId, client: options.client });
  }

  async check(input: CheckInput, call: { invocationId: string; signal?: AbortSignal }): Promise<CheckReceipt> {
    validateState(input.state);
    const keys = validateQuestions(input.questions);
    const afterDate = input.after_date === undefined ? undefined : calendarDate(input.after_date);
    if (input.location !== undefined && !/^[A-Za-z]{2}$/.test(input.location)) throw new Error("location must be a two-letter country code such as \"us\"");
    const location = input.location?.toLowerCase();
    const questions = input.questions;

    const body: Record<string, unknown> = {
      state: input.state,
      questions,
      mode: "fast",
      advanced_settings: {
        include_excerpts: true,
        ...(afterDate ? { after_date: afterDate } : {}),
        ...(location ? { location } : {}),
      },
    };
    const intent = { kind: "check" as const, state: input.state, questions, after_date: afterDate, location };

    const verdicts = (answers: Record<string, Answer>) =>
      keys.map(key => verdictLine(key, questions[key]!, answers[key]));

    const outcome = await this.calls.run({
      kind: "check",
      label: "Check",
      intent,
      invocation: call,
      send: (client, { options }) => client.post("/v1/decisions", { body, ...options }) as Promise<Response>,
      settle: (response, reference) => {
        if (!isPlain(response.answers) || !Array.isArray(response.citations)) {
          throw new UnusableResponse(
            "uncertain",
            "the decision response had no answers",
            `Check ran, but its response was unusable; record ${reference} is uncertain.`,
          );
        }
        const answers = response.answers as Record<string, Answer>;
        const sources = uniqueCitations(response.citations);
        const evidence: EvidenceInput[] = [
          {
            kind: "structured",
            origin: "provider_structured",
            ref: "verdicts",
            title: "Check verdicts",
            pointer: "answers",
            body: [...verdicts(answers), ...keys.map(key => `${key}: ${questions[key]!.instructions}`)].join("\n"),
            payload: answers,
          },
          ...sources.map((citation, i): EvidenceInput => {
            const title = typeof citation.title === "string" ? citation.title : undefined;
            const excerpts = Array.isArray(citation.excerpts) ? citation.excerpts.filter((e): e is string => typeof e === "string") : [];
            return {
              kind: "excerpt",
              origin: "provider_source",
              ref: `c${i}`,
              title,
              url: citation.url,
              pointer: `citations[${i}]`,
              body: excerpts.join("\n\n") || title || citation.url,
              payload: citation,
            };
          }),
        ];
        const citations: CitationInput[] = sources.map((citation, i) => ({
          evidence: "verdicts",
          source: `c${i}`,
          url: citation.url,
          title: typeof citation.title === "string" ? citation.title : undefined,
        }));
        return {
          summary: `Checked ${keys.length} question${keys.length === 1 ? "" : "s"} — ${sources.length} source${sources.length === 1 ? "" : "s"}`,
          providerRunId: typeof response.decision_id === "string" ? response.decision_id : undefined,
          rawResult: response,
          evidence,
          citations,
        };
      },
    });
    if (outcome.replayed) {
      return replayReceipt({ noun: "check", reference: outcome.reference, state: outcome.run?.state ?? "unknown", hits: outcome.hits });
    }

    const { reference, response } = outcome;
    const answers = response.answers as Record<string, Answer>;
    const sources = uniqueCitations(response.citations as unknown[]);
    const handleByPointer = new Map(outcome.evidence.map(item => [item.pointer, item.handle]));
    const handles = outcome.evidence.map(item => item.handle);
    const lines = verdicts(answers);
    const hosts = [...new Set(sources.map(source => host(source.url)).filter((h): h is string => !!h))].slice(0, MAX_SOURCES_SHOWN);
    const n = keys.length;
    const receiptLines = [
      `Checked ${n} question${n === 1 ? "" : "s"} about one state against ${sources.length} web source${sources.length === 1 ? "" : "s"} (fast mode).`,
      ...lines,
      sources.length ? `Sources (${sources.length}): ${hosts.join(", ")}` : undefined,
      ...sources.slice(0, MAX_SOURCES_SHOWN).map((source, i) => {
        const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : source.url;
        return `- ${title} — ${source.url} (${handleByPointer.get(`citations[${i}]`) ?? "not stored"})`;
      }),
      `Reference: ${reference}`,
    ].filter((line): line is string => line !== undefined);
    const footer = [`Read the verdicts and source excerpts with web_recall { reference: "${reference}" } or web_recall { handle }.`, UNTRUSTED];

    return {
      text: bounded(receiptLines, footer, { omitted: OMITTED }),
      details: {
        reference,
        questions: n,
        sources: sources.length,
        refusals: keys.filter(key => answers[key]?.type === "refusal").length,
        handles,
        answers: Object.fromEntries(keys.map(key => [key, answerDetail(answers[key])])),
      },
    };
  }
}

/** Per-Pi-session facade: one store, one session id, one provider client factory. */
export function createCheckService(options: { store: ResearchStore; sessionId: string; client: () => Promise<CheckClient> }) {
  const service = new Service(options);
  return { check: (input: CheckInput, call: { invocationId: string; signal?: AbortSignal }) => service.check(input, call) };
}

export type CheckService = ReturnType<typeof createCheckService>;
