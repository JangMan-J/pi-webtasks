/**
 * Search and Extract against Parallel, stored as session-owned evidence.
 *
 * This is the write half of the read interface: every provider result is
 * preserved in the local store, and the model sees only a bounded receipt with
 * stable handles. Provider identities (search id, extract id, provider session
 * id) stay in the store; the only thing a caller can pass back is a local
 * context handle, which the store resolves within the owning session.
 *
 * Call rules enforced here, not left to the model:
 *  - a Search call needs 1-3 concise keyword queries; the full objective is never
 *    copied into them,
 *  - `mode` is always sent explicitly (`basic` by default), because the provider
 *    default is `advanced`.
 *
 * Recording, replay, the single retry-free request, and failed-versus-uncertain
 * settlement are the recorded paid call's rules (`paid-call.ts`).
 */

import type { ExtractParams, ExtractResponse, SearchParams, SearchResult } from "parallel-web/resources";
import type { EvidenceInput, ResearchStore, SearchHit } from "./store.ts";
import { StoreError } from "./store.ts";
import { createPaidCalls, type PaidCalls } from "./paid-call.ts";
import { providerSourcePolicy, sourcePolicy } from "./source-policy.ts";
import { bounded, clean, replayReceipt, UNTRUSTED } from "./receipt.ts";

export type SearchMode = "turbo" | "fast" | "basic" | "advanced";

export const SEARCH_MODES: readonly SearchMode[] = ["turbo", "fast", "basic", "advanced"];
export const DEFAULT_SEARCH_MODE: SearchMode = "basic";

/** The subset of the Parallel client this module uses, so tests can supply a fake. */
export type ResearchClient = {
  search(body: SearchParams, options?: { signal?: AbortSignal; maxRetries?: number; timeout?: number }): Promise<SearchResult>;
  extract(body: ExtractParams, options?: { signal?: AbortSignal; maxRetries?: number; timeout?: number }): Promise<ExtractResponse>;
};

export type SearchInput = {
  objective?: string;
  search_queries?: string[];
  mode?: SearchMode;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  after_date?: string;
  /** Local context handle from an earlier Search or Extract receipt. */
  context?: string;
};

export type FetchInput = {
  urls: string[];
  objective?: string;
  search_queries?: string[];
  full_content?: boolean;
  max_age_seconds?: number;
  context?: string;
};

export type Receipt = { text: string; details: Record<string, unknown> };

const EXCERPT_PREVIEW = 220;
/** What a receipt says about lines it had to leave out. */
const OMITTED = "the sources are all stored and searchable";

type ServiceOptions = {
  store: ResearchStore;
  sessionId: string;
  client: () => Promise<ResearchClient>;
  /** Provider-side model hint for Search/Extract tailoring. */
  clientModel?: string;
};

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

export function parseSearchMode(value: string | undefined): SearchMode {
  if (value === undefined) return DEFAULT_SEARCH_MODE;
  if ((SEARCH_MODES as readonly string[]).includes(value)) return value as SearchMode;
  throw new Error(`mode must be one of ${SEARCH_MODES.join(", ")} (default ${DEFAULT_SEARCH_MODE})`);
}

function validateQueries(queries: string[] | undefined): string[] {
  const cleaned = (queries ?? []).map(query => query.trim()).filter(Boolean);
  if (!cleaned.length) throw new Error("search_queries needs 1-3 short keyword queries (3-6 words each)");
  if (cleaned.length > 3) throw new Error("search_queries takes at most 3 focused queries; merge the rest");
  return cleaned;
}

function httpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`"${value}" is not an http(s) URL`);
  return url.toString();
}

/**
 * Text of one received source. Full content wins when the provider returned it;
 * otherwise the returned excerpts are kept verbatim, blank-line separated.
 */
function sourceBody(item: { excerpts?: string[] | null; full_content?: string | null }, fallback: string): string {
  if (typeof item.full_content === "string" && item.full_content.trim()) return item.full_content;
  const excerpts = (item.excerpts ?? []).filter(excerpt => excerpt.trim());
  if (excerpts.length) return excerpts.join("\n\n");
  return fallback;
}

function searchSources(result: SearchResult): SearchResult["results"] {
  return Array.isArray(result.results) ? result.results : [];
}

function extractResults(result: ExtractResponse): ExtractResponse["results"] {
  return Array.isArray(result.results) ? result.results : [];
}

/** Search results as stored evidence, one excerpt item per returned source. */
function searchEvidence(sources: SearchResult["results"]): EvidenceInput[] {
  return sources.map((item, index) => {
    const url = typeof item.url === "string" ? item.url : undefined;
    const title = item.title ?? undefined;
    return {
      kind: "excerpt",
      origin: "provider_source",
      title,
      url,
      pointer: `results[${index}]`,
      body: sourceBody(item, title ?? url ?? "source"),
      payload: item,
    };
  });
}

/** Extract results with content as stored evidence; a URL that returned nothing stores nothing. */
function fetchEvidence(fetched: ExtractResponse["results"], fullContent: boolean): EvidenceInput[] {
  const evidence: EvidenceInput[] = [];
  fetched.forEach((item, index) => {
    const bodyText = sourceBody(item, "");
    if (!bodyText.trim()) return;
    evidence.push({
      kind: fullContent || typeof item.full_content === "string" ? "source" : "excerpt",
      origin: "provider_source",
      title: item.title ?? undefined,
      url: item.url,
      pointer: `results[${index}]`,
      body: bodyText,
      payload: item,
    });
  });
  return evidence;
}

class Service {
  private readonly store: ResearchStore;
  private readonly sessionId: string;
  private readonly calls: PaidCalls<ResearchClient>;
  private readonly clientModel?: string;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.calls = createPaidCalls({ store: options.store, sessionId: options.sessionId, client: options.client });
    this.clientModel = options.clientModel;
  }

  /** Resolve a caller-supplied local context handle to the provider session id. */
  private async contextHandle(handle: string | undefined): Promise<string | undefined> {
    const cleaned = clean(handle);
    if (!cleaned) return undefined;
    const providerSession = await this.store.providerContext(this.sessionId, cleaned).catch((err: unknown) => {
      if (err instanceof StoreError && err.code === "not_found") {
        throw new Error(`${cleaned} is not a Search/Extract context in this session`);
      }
      throw err;
    });
    if (!providerSession) throw new Error(`${cleaned} is not a Search/Extract context in this session`);
    return providerSession;
  }

  async search(input: SearchInput, call: { invocationId: string; signal?: AbortSignal }): Promise<Receipt> {
    const queries = validateQueries(input.search_queries);
    const mode = parseSearchMode(input.mode);
    const policy = sourcePolicy(input);
    const source_policy = providerSourcePolicy(policy);
    const maxResults = input.max_results ?? 10;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) throw new Error("max_results must be an integer from 1 to 20");
    const objective = clean(input.objective);
    const providerSessionId = await this.contextHandle(input.context);

    const intent = {
      kind: "search" as const,
      objective,
      search_queries: queries,
      mode,
      max_results: maxResults,
      include_domains: policy.include,
      exclude_domains: policy.exclude,
      after_date: policy.afterDate,
      context: clean(input.context),
    };
    const body: SearchParams = {
      search_queries: queries,
      mode,
      ...(objective ? { objective } : {}),
      ...(this.clientModel ? { client_model: this.clientModel } : {}),
      ...(providerSessionId ? { session_id: providerSessionId } : {}),
      advanced_settings: {
        max_results: maxResults,
        ...(source_policy ? { source_policy } : {}),
      },
    };

    const outcome = await this.calls.run({
      kind: "search",
      label: "Search",
      intent,
      invocation: call,
      send: (client, { options }) => client.search(body, options),
      settle: result => ({
        summary: searchesSummary(queries, searchSources(result).length),
        providerRunId: result.search_id,
        providerSessionId: result.session_id,
        rawResult: result,
        evidence: searchEvidence(searchSources(result)),
      }),
    });
    if (outcome.replayed) return this.replay("search call", outcome);

    const { reference, response: result } = outcome;
    const sources = searchSources(result);
    // Each source's evidence carries the pointer of the result it came from.
    const byPointer = new Map(outcome.evidence.map(item => [item.pointer, item.handle]));
    const handles = sources.map((_, index) => byPointer.get(`results[${index}]`));
    return {
      text: formatSearchReceipt({ reference, mode, queries, objective, providerSessionId: result.session_id, sources, handles }),
      details: {
        reference,
        context: reference,
        mode,
        sources: sources.length,
        saved: outcome.evidence.length,
        handles: outcome.evidence.map(item => item.handle),
      },
    };
  }

  async fetch(input: FetchInput, call: { invocationId: string; signal?: AbortSignal }): Promise<Receipt> {
    const urls = [...new Set((input.urls ?? []).map(url => httpUrl(url.trim())).filter(Boolean))];
    if (!urls.length) throw new Error("urls needs at least one absolute http(s) URL");
    if (urls.length > 20) throw new Error("urls takes at most 20 URLs per request");
    const queries = (input.search_queries ?? []).map(query => query.trim()).filter(Boolean);
    if (queries.length > 3) throw new Error("search_queries takes at most 3 focused queries");
    const objective = clean(input.objective);
    const maxAge = input.max_age_seconds;
    if (maxAge !== undefined && (!Number.isInteger(maxAge) || maxAge < 600)) throw new Error("max_age_seconds must be an integer of at least 600");
    const providerSessionId = await this.contextHandle(input.context);
    const fullContent = input.full_content === true;

    const intent = {
      kind: "extract" as const,
      urls,
      objective,
      search_queries: queries,
      full_content: fullContent,
      max_age_seconds: maxAge,
      context: clean(input.context),
    };
    const advancedSettings: ExtractParams["advanced_settings"] = {
      ...(maxAge === undefined ? {} : { fetch_policy: { max_age_seconds: maxAge } }),
      ...(fullContent ? { full_content: true } : {}),
    };
    const body: ExtractParams = {
      urls,
      ...(queries.length ? { search_queries: queries } : {}),
      ...(objective ? { objective } : {}),
      ...(this.clientModel ? { client_model: this.clientModel } : {}),
      ...(providerSessionId ? { session_id: providerSessionId } : {}),
      ...(Object.keys(advancedSettings).length ? { advanced_settings: advancedSettings } : {}),
    };

    const outcome = await this.calls.run({
      kind: "extract",
      label: "Fetch",
      intent,
      invocation: call,
      send: (client, { options }) => client.extract(body, options),
      settle: result => ({
        summary: `Read ${extractResults(result).length} of ${urls.length} URL${urls.length === 1 ? "" : "s"}`,
        providerRunId: result.extract_id,
        providerSessionId: result.session_id,
        rawResult: result,
        evidence: fetchEvidence(extractResults(result), fullContent),
      }),
    });
    if (outcome.replayed) return this.replay("fetch", outcome);

    const { reference, response: result } = outcome;
    const fetched = extractResults(result);
    const failures = Array.isArray(result.errors) ? result.errors : [];
    // Each stored item carries the URL it was read from.
    const handles = new Map<string, string>(outcome.evidence.flatMap(item => (item.url ? [[item.url, item.handle] as const] : [])));
    return {
      text: formatFetchReceipt({ reference, urls, fetched, failures, handles, fullContent }),
      details: {
        reference,
        context: reference,
        requested: urls.length,
        fetched: fetched.length,
        failed: failures.length,
        saved: outcome.evidence.length,
        handles: outcome.evidence.map(item => item.handle),
      },
    };
  }

  /**
   * A replayed invocation never spends again. The receipt points at what is
   * already stored, whether that outcome is finished, running, or uncertain.
   */
  private replay(noun: string, outcome: { reference: string; run?: { state: string }; hits: SearchHit[] }): Receipt {
    const { text, details } = replayReceipt({ noun, reference: outcome.reference, state: outcome.run?.state ?? "unknown", hits: outcome.hits });
    return { text, details: { ...details, context: outcome.reference } };
  }
}

function searchesSummary(queries: string[], count: number): string {
  return `Searched ${queries.map(query => `"${query}"`).join(", ")} — ${count} source${count === 1 ? "" : "s"}`;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_PREVIEW) return flat;
  const cut = sentences(flat).reduce((acc, sentence) => (acc.length >= EXCERPT_PREVIEW ? acc : `${acc}${sentence} `), "").trim();
  const chosen = cut.length >= 40 ? cut : flat.slice(0, EXCERPT_PREVIEW);
  return `${chosen}${chosen.length < flat.length ? "…" : ""}`;
}

function formatSearchReceipt(input: {
  reference: string;
  mode: SearchMode;
  queries: string[];
  objective?: string;
  providerSessionId?: string | null;
  sources: { url?: string | null; title?: string | null; publish_date?: string | null; excerpts?: string[] | null; full_content?: string | null }[];
  handles: (string | undefined)[];
}): string {
  const { reference, mode, queries, sources, handles } = input;
  const lines = [
    `Searched ${sources.length} source${sources.length === 1 ? "" : "s"} (${mode} mode) with ${queries.length} quer${queries.length === 1 ? "y" : "ies"}: ${queries.map(query => `"${query}"`).join(", ")}.`,
    input.objective ? `Objective: ${input.objective}` : undefined,
    `Context handle: ${reference} — pass it as context to the related web_search and web_fetch calls of this task.`,
    sources.length ? "Sources and stored evidence:" : "No sources were returned. Try other keyword phrases (different names, aliases, or angles), a broader objective, or another mode.",
    ...sources.map((source, index) => {
      const handle = handles[index];
      const title = source.title?.trim() || source.url || `source ${index + 1}`;
      const body = sourceBody(source, "");
      const date = source.publish_date ? `, published ${source.publish_date}` : "";
      return [
        `- ${title}${source.url ? ` — ${source.url}` : ""} (${body.length.toLocaleString("en-US")} chars${date})`,
        handle ? `  ${handle}: ${preview(body)}` : undefined,
      ].filter(Boolean).join("\n");
    }),
  ].filter((line): line is string => line !== undefined);

  const searchAgain = "Read an item in full with web_recall { handle }; search everything stored with web_recall { query }. web_fetch a URL, with the same objective, when its excerpt is not enough.";
  return bounded(lines, [searchAgain, UNTRUSTED], { omitted: OMITTED });
}

function formatFetchReceipt(input: {
  reference: string;
  urls: string[];
  fetched: { url?: string; title?: string | null; excerpts?: string[] | null; full_content?: string | null }[];
  failures: { url?: string; error_type?: string; http_status_code?: number | null; content?: string | null }[];
  handles: Map<string, string>;
  fullContent: boolean;
}): string {
  const { reference, urls, fetched, failures, handles } = input;
  const lines = [
    `Read ${fetched.length} of ${urls.length} URL${urls.length === 1 ? "" : "s"}${input.fullContent ? " (full content requested)" : ""}.`,
    `Context handle: ${reference} — pass it as context to the related web_search and web_fetch calls of this task.`,
    ...fetched.map(item => {
      const handle = item.url ? handles.get(item.url) : undefined;
      const body = sourceBody(item, "");
      return [
        `- ${item.title?.trim() || item.url || "source"}${item.url ? ` — ${item.url}` : ""} (${body.length.toLocaleString("en-US")} chars stored)`,
        handle ? `  ${handle}: ${preview(body)}` : "  no content was returned for this URL",
      ].join("\n");
    }),
    ...failures.map(failure => `- ${failure.url ?? "URL"}: ${failure.error_type ?? "error"}${failure.http_status_code ? ` (HTTP ${failure.http_status_code})` : ""}${failure.content ? ` — ${failure.content.slice(0, 200)}` : ""}`),
  ];
  const footer = ["Read more with web_recall { handle, offset }; search all stored evidence with web_recall { query }.", UNTRUSTED];
  return bounded(lines, footer, { omitted: OMITTED });
}

/** Per-Pi-session facade: one store, one session id, one provider client factory. */
export function createResearchService(options: ServiceOptions) {
  const service = new Service(options);
  return {
    search: (input: SearchInput, call: { invocationId: string; signal?: AbortSignal }) => service.search(input, call),
    fetch: (input: FetchInput, call: { invocationId: string; signal?: AbortSignal }) => service.fetch(input, call),
  };
}

export type ResearchService = ReturnType<typeof createResearchService>;
