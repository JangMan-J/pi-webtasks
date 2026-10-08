import { packageAdjacentKey } from "./env.ts";
import { domainToASCII } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Parallel, APIError, APIConnectionTimeoutError } from "parallel-web";
import { verifyWebhook } from "./webhook.ts";
import { PartialResponseError, errorData, researchFailure, researchOutput } from "./results.ts";

export const SEARCH_DEFAULTS = { max_results: 20, max_chars_total: 50_000, max_chars_per_result: 10_000 } as const;
export const EXTRACT_DEFAULTS = { max_chars_total: 100_000, max_chars_per_result: 20_000, full_content: true } as const;


export type CallOpts = {
  signal?: AbortSignal;
  cwd?: string;
  artifactDir?: string;
  onProgress?: (msg: string) => void;
  clientModel?: string;
};

export type ToolArgs = Record<string, unknown>;

export function parseJson(value: unknown, name: string): unknown {
  if (value == null || value === "") return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") throw new Error(`${name} must be JSON`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

export function formatError(err: unknown): string {
  if (err instanceof APIError) {
    return JSON.stringify(errorData(err), null, 2);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Where a key stored by Pi's /login comes from. Absent when the caller runs without Pi (the standalone receiver). */
export type StoredKey = () => Promise<string | undefined>;

/** Shown when Pi runs the extension. The sentence names the one step a user can take inside Pi. */
export const MISSING_KEY_IN_PI = "Run /login, choose Parallel, and paste an API key — or set _PARALLEL_API_KEY.";
/** Shown when there is no Pi login, so the only sources are the environment and the package key file. */
export const MISSING_KEY_STANDALONE = "Parallel API key missing. Set _PARALLEL_API_KEY in the environment, or put it in .env or parallel.env beside the package manifest.";

export type KeySource = "stored credential" | "environment" | "key file";

/**
 * The one precedence rule for the research key: the stored login, then _PARALLEL_API_KEY, then
 * PARALLEL_API_KEY from the environment, then the package-adjacent key file. Pure, so tests can drive it.
 */
export function resolveResearchKey(input: {
  stored?: string;
  env?: Record<string, string | undefined>;
  packageKey?: string;
}): { key: string; source: KeySource } | undefined {
  const stored = input.stored?.trim();
  if (stored) return { key: stored, source: "stored credential" };
  const env = input.env ?? process.env;
  for (const name of ["_PARALLEL_API_KEY", "PARALLEL_API_KEY"]) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: "environment" };
  }
  const file = input.packageKey?.trim();
  return file ? { key: file, source: "key file" } : undefined;
}

/** Resolved on every call, never cached, so a login or logout takes effect on the next request. */
export async function researchKey(stored?: StoredKey): Promise<string> {
  const resolved = resolveResearchKey({ stored: stored ? await stored() : undefined, packageKey: packageAdjacentKey() });
  if (!resolved) throw new Error(stored ? MISSING_KEY_IN_PI : MISSING_KEY_STANDALONE);
  return resolved.key;
}

export async function researchClient(stored?: StoredKey): Promise<Parallel> {
  return new Parallel({ apiKey: await researchKey(stored), timeout: 120_000, maxRetries: 2 });
}

function req(opts?: CallOpts, extra: { timeout?: number; maxRetries?: number } = {}) {
  return { ...extra, signal: opts?.signal };
}

function jsonOutputSchema(value: unknown) {
  const parsed = parseJson(value, "output_schema");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("output_schema must be a JSON Schema object");
  const schema = parsed as Record<string, unknown>;
  const json_schema = "json_schema" in schema ? schema.json_schema : schema;
  if (!json_schema || typeof json_schema !== "object" || Array.isArray(json_schema)) throw new Error("output_schema.json_schema must be an object");
  return { type: "json" as const, json_schema: json_schema as Record<string, unknown> };
}

function taskSpec(args: ToolArgs) {
  if (args.output_schema === undefined) return parseJson(args.task_spec, "task_spec");
  if (args.task_spec != null) throw new Error("Use output_schema or task_spec, not both");
  return { output_schema: jsonOutputSchema(args.output_schema) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function strs(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function sourcePolicy(args: ToolArgs): Record<string, unknown> | undefined {
  const parsed = parseJson(args.source_policy, "source_policy") as Record<string, unknown> | undefined;
  const policy: Record<string, unknown> = { ...(parsed || {}) };
  const include = strs(args.include_domains);
  const exclude = strs(args.exclude_domains);
  if (include) policy.include_domains = include;
  if (exclude) policy.exclude_domains = exclude;
  if (str(args.after_date)) policy.after_date = args.after_date;
  return Object.keys(policy).length ? policy : undefined;
}

const WEBHOOK_EVENTS = {
  task: ["task_run.status"],
  findall: ["findall.run.completed", "findall.run.cancelled", "findall.run.failed"],
  monitor: ["monitor.event.detected", "monitor.execution.completed", "monitor.execution.failed"],
};

function webhook(args: ToolArgs, kind: keyof typeof WEBHOOK_EVENTS): { url: string; event_types: string[] } | undefined {
  if (args.webhook_url == null) return undefined;
  const url = str(args.webhook_url);
  if (!url) throw new Error("webhook_url must be an HTTP(S) URL or null");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("webhook_url must be an HTTP(S) URL without credentials or a fragment");
  }
  const events = args.webhook_events;
  if (events !== undefined && (!Array.isArray(events) || events.length === 0 || events.some(e => typeof e !== "string" || !e.trim()))) {
    throw new Error("webhook_events must be a non-empty array of event types");
  }
  return { url, event_types: events === undefined ? WEBHOOK_EVENTS[kind] : events as string[] };
}

function betasFor(args: ToolArgs, extra: string[] = []): string[] | undefined {
  const b = new Set(extra);
  if (args.mcp_servers) b.add("mcp-server-2025-07-17");
  if (args.enable_events === true) b.add("events-sse-2025-07-24");
  return b.size ? [...b] : undefined;
}

async function collectStream(
  open: (opts: CallOpts) => Promise<AsyncIterable<unknown>>,
  opts: CallOpts | undefined, wait = 15, limit = 40, cursor?: string,
) {
  if (!Number.isFinite(wait) || wait < 0) throw new Error("wait_seconds must be nonnegative");
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("limit must be a positive integer");
  const deadline = new AbortController();
  const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new Error("Stream wait deadline reached")), wait * 1000);
  const events: unknown[] = [];
  let last_event_id: string | null = cursor ?? null;
  let limit_reached = false;
  try {
    signal.throwIfAborted();
    const stream = await open({ ...opts, signal });
    for await (const ev of stream) {
      signal.throwIfAborted();
      events.push(ev);
      if (ev && typeof ev === "object") {
        const event = ev as Record<string, unknown>;
        if (typeof event.event_id === "string" && event.event_id) last_event_id = event.event_id;
        if (event.type === "error" || event.event_type === "error") throw new Error("Stream returned an error event");
      }
      opts?.onProgress?.(`event ${events.length}`);
      signal.throwIfAborted();
      if (events.length >= limit) { limit_reached = true; break; }
    }
    // The SDK treats AbortError as EOF. Do not turn cancellation into success.
    signal.throwIfAborted();
  } catch (err) {
    const partial = { events, last_event_id, partial: true, error: errorData(err) };
    if (deadline.signal.aborted && !opts?.signal?.aborted) return { ...partial, timeout: true, limit_reached };
    throw new PartialResponseError("Stream interrupted", partial);
  } finally {
    clearTimeout(timer);
  }
  return { events, last_event_id, limit_reached };
}

function wrap(args: ToolArgs, opts: CallOpts | undefined, data: unknown) {
  return researchOutput(data, args, opts);
}

function retrievalNumbers(args: ToolArgs) {
  for (const key of ["max_results", "max_chars_total", "max_chars_per_result", "max_age_seconds"]) {
    if (args[key] !== undefined && !Number.isSafeInteger(args[key])) throw new Error(`${key} must be an integer`);
  }
  if (typeof args.max_age_seconds === "number" && args.max_age_seconds < 600) throw new Error("max_age_seconds must be at least 600");
  if (args.full_content && typeof args.full_content === "object") retrievalNumbers(args.full_content as ToolArgs);
}

export async function search(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  retrievalNumbers(args);
  const search_queries = strs(args.search_queries);
  if (!search_queries?.length) throw new Error("search_queries required (1–5 keyword queries, 3–6 words each)");
  const fetch_policy: Record<string, unknown> = {};
  if (num(args.max_age_seconds) != null) fetch_policy.max_age_seconds = args.max_age_seconds;
  if (bool(args.disable_cache_fallback) != null) fetch_policy.disable_cache_fallback = args.disable_cache_fallback;
  if (num(args.fetch_timeout_seconds) != null) fetch_policy.timeout_seconds = args.fetch_timeout_seconds;
  const advanced: Record<string, unknown> = {
    max_results: num(args.max_results) ?? SEARCH_DEFAULTS.max_results,
    excerpt_settings: { max_chars_per_result: num(args.max_chars_per_result) ?? SEARCH_DEFAULTS.max_chars_per_result },
  };
  if (str(args.location)) advanced.location = args.location;
  const sp = sourcePolicy(args);
  if (args.mode === "turbo" && [sp?.include_domains, sp?.exclude_domains].some(list => Array.isArray(list) && list.some(x => typeof x === "string" && x.includes("/")))) {
    throw new Error("Search turbo does not support path filters. Use fast, basic, or advanced.");
  }
  if (sp) advanced.source_policy = sp;
  if (Object.keys(fetch_policy).length) advanced.fetch_policy = fetch_policy;
  const data = await client.search(
    {
      search_queries,
      objective: str(args.objective),
      mode: (str(args.mode) as "turbo" | "fast" | "basic" | "advanced") || "fast",
      max_chars_total: num(args.max_chars_total) ?? SEARCH_DEFAULTS.max_chars_total,
      session_id: str(args.session_id),
      client_model: str(args.client_model) ?? opts?.clientModel,
      advanced_settings: Object.keys(advanced).length ? advanced : undefined,
    },
    req(opts, { maxRetries: 0 }),
  );
  return wrap(args, opts, data);
}

export async function extract(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  retrievalNumbers(args);
  const urls = strs(args.urls);
  if (!urls?.length) throw new Error("urls required (max 20)");
  if (urls.length > 20) throw new Error("urls: max 20");
  const fetch_policy: Record<string, unknown> = {};
  if (num(args.max_age_seconds) != null) fetch_policy.max_age_seconds = args.max_age_seconds;
  if (bool(args.disable_cache_fallback) != null) fetch_policy.disable_cache_fallback = args.disable_cache_fallback;
  if (num(args.fetch_timeout_seconds) != null) fetch_policy.timeout_seconds = args.fetch_timeout_seconds;
  const advanced: Record<string, unknown> = {
    excerpt_settings: { max_chars_per_result: num(args.max_chars_per_result) ?? EXTRACT_DEFAULTS.max_chars_per_result },
    full_content: args.full_content ?? EXTRACT_DEFAULTS.full_content,
  };
  if (Object.keys(fetch_policy).length) advanced.fetch_policy = fetch_policy;
  const data = await client.extract(
    {
      urls,
      objective: str(args.objective),
      search_queries: strs(args.search_queries),
      max_chars_total: num(args.max_chars_total) ?? EXTRACT_DEFAULTS.max_chars_total,
      session_id: str(args.session_id),
      client_model: str(args.client_model) ?? opts?.clientModel,
      advanced_settings: Object.keys(advanced).length ? advanced : undefined,
    },
    req(opts, { maxRetries: 0 }),
  );
  return wrap(args, opts, data);
}

function responsesText(resp: Record<string, unknown>): string {
  if (typeof resp.output_text === "string") return resp.output_text;
  const output = resp.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
        parts.push((c as { text: string }).text);
      }
    }
  }
  return parts.join("\n");
}

function completedResponse(response: Record<string, unknown>): boolean {
  return response.status === "completed" && (!Array.isArray(response.output) || response.output.every(item =>
    !item || typeof item !== "object" || item.type !== "message" || item.status === undefined || item.status === "completed"));
}

async function collectResponse(stream: AsyncIterable<unknown>, opts?: CallOpts) {
  const events: unknown[] = [];
  let response: Record<string, unknown> = {};
  try {
    for await (const event of stream) {
      opts?.signal?.throwIfAborted();
      events.push(event);
      const ev = event as { type?: string; response?: Record<string, unknown> };
      if (ev.response) response = { ...response, ...ev.response };
      opts?.onProgress?.(`event ${events.length}`);
      opts?.signal?.throwIfAborted();
      if (ev.type === "response.completed") {
        const text = responsesText(response);
        if (!completedResponse(response) || !text.trim()) throw new Error("Responses completion lacks a completed, nonempty answer");
        return { events, response, output_text: text };
      }
      if (["response.failed", "response.incomplete", "error"].includes(ev.type ?? "")) throw new Error(`Responses stream ended with ${ev.type}`);
    }
    opts?.signal?.throwIfAborted();
    throw new Error("Responses stream ended before response.completed");
  } catch (err) {
    throw new PartialResponseError("Responses stream incomplete", { events, response, partial: true, error: errorData(err) });
  }
}

function responseFilters(args: ToolArgs) {
  if (args.allowed_domains !== undefined && args.blocked_domains !== undefined) {
    throw new Error("Use allowed_domains or blocked_domains, not both. The API ignores the block list when an allow list is present.");
  }
  const key = args.allowed_domains !== undefined ? "allowed_domains" : "blocked_domains";
  const entries = args[key];
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries) || entries.length > 200) throw new Error(`${key} must be an array with at most 200 entries`);
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry || /[\s:*?#@\\]/u.test(entry)) throw new Error(`Invalid ${key} entry. Use domains, path prefixes, or bare extensions without schemes, ports, queries, or fragments.`);
    const [host, ...path] = entry.split("/");
    const extension = host!.startsWith(".");
    const domain = domainToASCII(extension ? host!.slice(1) : host!);
    const labels = domain.split(".");
    if (!domain || (!extension && labels.length < 2) || (extension && path.length) || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      throw new Error(`Invalid ${key} domain or extension`);
    }
  }
  return { [key]: entries };
}

export async function responses(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  const filters = responseFilters(args);
  const input = typeof args.input === "string"
    ? args.input.trim() ? args.input : undefined
    : Array.isArray(args.input) && args.input.length ? args.input : undefined;
  if (!input) throw new Error("input must be a non-empty string or message array");
  if (Array.isArray(input) && (input.some(message => !message || typeof message !== "object" ||
    !["user", "assistant", "system", "developer"].includes(message.role) || typeof message.content !== "string") ||
    !input.some(message => message.role === "user" && message.content.trim()))) {
    throw new Error("input must contain text-only messages and at least one non-empty user message");
  }
  const effort = str(args.effort) || "low";
  if (!["low", "medium", "high"].includes(effort)) throw new Error("effort must be low, medium, or high");
  const timeout = effort === "high" ? 120_000 : effort === "medium" ? 60_000 : 30_000;
  const body: Record<string, unknown> = {
    model: "parallel",
    input,
    reasoning: { effort },
  };
  if (str(args.previous_response_id)) body.previous_response_id = args.previous_response_id;
  if (str(args.instructions)) body.instructions = args.instructions;
  if (filters) body.tools = [{ type: "web_search", filters }];
  if (args.metadata !== undefined) {
    const metadata = parseJson(args.metadata, "metadata");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).length > 16 ||
      Object.entries(metadata).some(([key, value]) => [...key].length > 64 || typeof value !== "string" || [...value].length > 512)) {
      throw new Error("metadata must be an object with at most 16 string values, 64 characters per key, and 512 characters per value");
    }
    body.metadata = metadata;
  }
  const format = parseJson(args.text_format, "text_format");
  if (format) body.text = { format };
  // The client was built for this request with the key resolved for it, so the Bearer header matches it.
  const headers = { Authorization: `Bearer ${client.apiKey}` };
  if (args.stream === true) {
    const stream = (await client.post("/v1/responses", {
      body: { ...body, stream: true },
      headers,
      ...req(opts, { timeout, maxRetries: 0 }),
      stream: true,
    })) as AsyncIterable<unknown>;
    const data = await collectResponse(stream, opts);
    return wrap(args, opts, data);
  }
  const data = (await client.post("/v1/responses", { body, headers, ...req(opts, { timeout, maxRetries: 0 }) })) as Record<string, unknown>;
  const text = responsesText(data);
  if (!text.trim()) return researchFailure({ error: "empty Responses answer after HTTP success", response: data }, args, opts);
  if (!completedResponse(data)) return researchFailure({ error: "Responses answer was not completed", partial: true, output_text: text, response: data }, args, opts);
  return wrap(args, opts, { output_text: text, response: data });
}

// Strict one-shot retrieval for the webhook completion path: exactly one
// request, no status-lookup fallback and no wait/poll loop. A callback
// already told the caller the run is terminal; do not turn a transient
// result-fetch failure into a second network call. See
// docs/webhook-integration-review.md "4. Concrete extension gaps".
export async function taskResultOnce(client: Parallel, run_id: string, opts?: CallOpts): Promise<unknown> {
  return client.taskRun.result(run_id, { timeout: 0 }, req(opts, { maxRetries: 0 }));
}

/** One-shot FindAll snapshot, reusing the existing wait_seconds:0 semantics. */
export async function findallResultOnce(client: Parallel, findall_id: string, opts?: CallOpts): Promise<unknown> {
  return client.beta.findall.result(findall_id, undefined, req(opts, { maxRetries: 0 }));
}

/** One-shot Monitor event-group retrieval for a detected event. */
export async function monitorEventGroupOnce(client: Parallel, monitor_id: string, event_group_id: string, opts?: CallOpts): Promise<unknown> {
  return client.monitor.events(monitor_id, { event_group_id, include_completions: true }, req(opts, { maxRetries: 0 }));
}

async function taskResult(client: Parallel, args: ToolArgs, opts: CallOpts | undefined, wait: number, known: { run_id: string; [key: string]: unknown }) {
  let data: object | undefined;
  try {
    data = await client.taskRun.result(known.run_id, { timeout: wait }, req(opts, { timeout: (wait + 5) * 1000, maxRetries: 0 }));
    opts?.signal?.throwIfAborted();
    return wrap(args, opts, { ...known, ...data });
  } catch (err) {
    const partial = { ...known, ...data, partial: true, error: errorData(err) };
    if (opts?.signal?.aborted) throw new PartialResponseError("Task wait cancelled", partial);
    let status;
    try {
      status = await client.taskRun.retrieve(known.run_id, req(opts));
    } catch (statusError) {
      throw new PartialResponseError("Task result and status retrieval failed", {
        ...partial, error: { result: errorData(err), status: errorData(statusError) },
      });
    }
    const timeout = err instanceof APIConnectionTimeoutError || err instanceof APIError && (
      err.status === 408 || err.status === 400 && /not ready|not completed|timed? ?out/i.test(formatError(err))
    );
    if (!timeout) throw new PartialResponseError("Task result retrieval failed", { ...partial, run: status });
    return wrap(args, opts, { ...known, timeout: true, run: status, error: errorData(err) });
  }
}

export async function task(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  const action = str(args.action) || "create";
  const run_id = str(args.run_id);
  const wait = num(args.wait_seconds);
  if (args.wait_seconds !== undefined && (wait === undefined || wait < 0)) throw new Error("wait_seconds must be nonnegative");
  if (action === "create") {
    const input = args.input ?? str(args.objective);
    if (input == null || (typeof input === "string" ? !input.trim() : typeof input !== "object" || Array.isArray(input))) throw new Error("input must be non-empty text or a JSON object");
    const processor = str(args.processor);
    if (!processor) throw new Error("processor required (lite|base|core|core2x|pro|ultra and -fast / 2x/4x/8x variants)");
    const params: Record<string, unknown> = {
      input,
      processor,
      enable_events: args.enable_events === false ? false : true,
      previous_interaction_id: str(args.previous_interaction_id),
      memory_scope_key: str(args.memory_scope_key),
      metadata: parseJson(args.metadata, "metadata"),
      task_spec: taskSpec(args),
      mcp_servers: parseJson(args.mcp_servers, "mcp_servers"),
      source_policy: sourcePolicy(args),
      webhook: webhook(args, "task"),
      betas: betasFor(args, ["events-sse-2025-07-24"]),
    };
    if (str(args.location)) params.advanced_settings = { location: args.location };
    const created = await client.taskRun.create(params as never, req(opts, { maxRetries: 0 }));
    if (wait && wait > 0) {
      // Keep an independent receipt: an explicit final output path remains exclusive.
      const receipt = await wrap({ ...args, output_path: undefined, overwrite: false, return_mode: "file" }, opts, created);
      const known = { run_id: created.run_id, creation_artifact: receipt.artifact, run: created };
      opts?.onProgress?.(`Task ${created.run_id} created; receipt: ${receipt.artifact}. Do not recreate after a wait failure.`);
      return taskResult(client, args, opts, wait, known);
    }
    return wrap(args, opts, created);
  }
  if (!run_id) throw new Error("run_id required");
  if (action === "status") return wrap(args, opts, await client.taskRun.retrieve(run_id, req(opts)));
  if (action === "input") return wrap(args, opts, await client.taskRun.retrieveInput(run_id, req(opts)));
  if (action === "result") return taskResult(client, args, opts, wait ?? 45, { run_id });
  if (action === "events") {
    return wrap(args, opts, await collectStream(o => client.taskRun.events(run_id, req(o)), opts, wait ?? 15, Infinity));
  }
  throw new Error(`unknown task action ${action}`);
}

export async function group(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  const action = str(args.action) || "create";
  const taskgroup_id = str(args.taskgroup_id);
  if (action === "create") {
    return wrap(args, opts, await client.taskGroup.create({ metadata: parseJson(args.metadata, "metadata") as never }, req(opts, { maxRetries: 0 })));
  }
  if (!taskgroup_id) throw new Error("taskgroup_id required");
  if (action === "status") return wrap(args, opts, await client.taskGroup.retrieve(taskgroup_id, req(opts)));
  if (action === "add") {
    const inputs = parseJson(args.inputs, "inputs");
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("inputs JSON array required");
    // Webhooks belong to individual runs. Preserve per-input overrides and
    // null opt-outs, but supply the required Task event subscription.
    const groupDefault = webhook(args, "task");
    const withWebhooks = inputs.map(input => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Each group input must be an object");
      if (input.webhook === null) return input;
      if (input.webhook !== undefined) {
        if (!input.webhook || typeof input.webhook !== "object" || Array.isArray(input.webhook) || !input.webhook.url) {
          throw new Error("Each input webhook must contain a url or be null");
        }
        return { ...input, webhook: webhook({ webhook_url: input.webhook.url, webhook_events: input.webhook.event_types }, "task") };
      }
      return groupDefault ? { ...input, webhook: groupDefault } : input;
    });
    return wrap(
      args,
      opts,
      await client.taskGroup.addRuns(
        taskgroup_id,
        {
          inputs: withWebhooks as never,
          default_task_spec: taskSpec(args) as never,
          betas: betasFor(args),
        },
        req(opts, { maxRetries: 0 }),
      ),
    );
  }
  if (action === "run") {
    const run_id = str(args.run_id);
    if (!run_id) throw new Error("run_id required");
    return wrap(args, opts, await client.taskGroup.retrieveRun(run_id, { taskgroup_id }, req(opts)));
  }
  if (action === "runs") {
    return wrap(args, opts, await collectStream(o => client.taskGroup.getRuns(
      taskgroup_id,
      {
        include_input: bool(args.include_input),
        include_output: bool(args.include_output),
        last_event_id: str(args.last_event_id),
        status: str(args.status) as never,
      },
      req(o),
    ), opts, num(args.wait_seconds) ?? 15, num(args.limit) ?? 40, str(args.last_event_id)));
  }
  if (action === "events") {
    return wrap(args, opts, await collectStream(o => client.taskGroup.events(
      taskgroup_id,
      { last_event_id: str(args.last_event_id), timeout: num(args.wait_seconds) ?? 15 },
      req(o),
    ), opts, num(args.wait_seconds) ?? 15, 40, str(args.last_event_id)));
  }
  throw new Error(`unknown group action ${action}`);
}

export async function findall(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  const action = str(args.action) || "create";
  const findall_id = str(args.findall_id);
  if (action === "ingest") {
    const objective = str(args.objective);
    if (!objective) throw new Error("objective required");
    return wrap(args, opts, await client.beta.findall.ingest({ objective }, req(opts)));
  }
  if (action === "entity_search") {
    const objective = str(args.objective);
    const entity_type = str(args.entity_type) as "people" | "companies" | undefined;
    if (!objective || (entity_type !== "people" && entity_type !== "companies")) {
      throw new Error(`entity_search needs objective and entity_type "people" or "companies" (received ${JSON.stringify(args.entity_type ?? null)})`);
    }
    return wrap(args, opts, await client.beta.findall.entitySearch({ entity_type, objective, match_limit: num(args.match_limit) }, req(opts, { maxRetries: 0 })));
  }
  if (action === "create" || action === "preview") {
    const objective = str(args.objective);
    let entity_type = str(args.entity_type);
    let match_conditions = parseJson(args.match_conditions, "match_conditions") as unknown[] | undefined;
    if (match_conditions !== undefined && (!Array.isArray(match_conditions) || match_conditions.some(c =>
      !c || typeof c !== "object" || typeof (c as Record<string, unknown>).name !== "string" || typeof (c as Record<string, unknown>).description !== "string"
    ))) throw new Error("match_conditions must be an array of {name, description} objects");
    const generator = (str(args.generator) as "base" | "core" | "pro" | "preview") || (action === "preview" ? "preview" : "core");
    if (!match_conditions || !entity_type) {
      if (!objective) throw new Error("objective required (or pass entity_type + match_conditions)");
      const spec = await client.beta.findall.ingest({ objective }, req(opts));
      entity_type = entity_type || spec.entity_type;
      match_conditions = match_conditions || spec.match_conditions;
    }
    if (!entity_type || !match_conditions) throw new Error("ingest did not return entity_type/match_conditions");
    const created = await client.beta.findall.create(
      {
        entity_type,
        generator,
        match_conditions: match_conditions as never,
        match_limit: num(args.match_limit) ?? 10,
        objective: objective || "",
        exclude_list: parseJson(args.exclude_list, "exclude_list") as never,
        memory_scope_key: str(args.memory_scope_key),
        metadata: parseJson(args.metadata, "metadata") as never,
        webhook: webhook(args, "findall") as never,
        betas: betasFor(args, ["findall-2025-09-15"]),
      },
      req(opts, { maxRetries: 0 }),
    );
    return wrap(args, opts, created);
  }
  if (!findall_id) throw new Error("findall_id required");
  if (action === "status") return wrap(args, opts, await client.beta.findall.retrieve(findall_id, undefined, req(opts)));
  if (action === "schema") return wrap(args, opts, await client.beta.findall.schema(findall_id, undefined, req(opts)));
  if (action === "result") {
    const wait = num(args.wait_seconds) ?? 45;
    if (wait < 0 || args.wait_seconds !== undefined && num(args.wait_seconds) === undefined) throw new Error("wait_seconds must be nonnegative");
    if (wait === 0) return wrap(args, opts, await client.beta.findall.result(findall_id, undefined, req(opts)));
    const deadline = performance.now() + wait * 1000;
    const expired = AbortSignal.timeout(Math.ceil(wait * 1000));
    const signal = opts?.signal ? AbortSignal.any([opts.signal, expired]) : expired;
    let latest: Record<string, unknown> = { findall_id };
    try {
      do {
        const data = await client.beta.findall.result(findall_id, undefined, req({ ...opts, signal }, { timeout: Math.max(1, Math.ceil(deadline - performance.now())) }));
        latest = { ...data, findall_id };
        const status = data.run.status;
        if (!status.is_active || !["queued", "running", "cancelling"].includes(status.status)) return wrap(args, opts, latest);
        opts?.onProgress?.(`FindAll ${findall_id}: ${status.status}`);
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await delay(Math.ceil(Math.min(1000, remaining)), undefined, { signal });
        if (remaining <= 1000) break; // A short deadline is not another polling interval.
      } while (performance.now() < deadline);
    } catch (err) {
      if (opts?.signal?.aborted || !expired.aborted && performance.now() < deadline) {
        throw new PartialResponseError("FindAll wait interrupted", { ...latest, partial: true, error: errorData(err) });
      }
      latest = { ...latest, error: {
        message: latest.run ? "FindAll deadline interrupted a result request" : "FindAll deadline reached before the first snapshot",
        cause: errorData(err),
      } };
    }
    return wrap(args, opts, { ...latest, timeout: true });
  }
  if (action === "cancel") return wrap(args, opts, await client.beta.findall.cancel(findall_id, undefined, req(opts, { maxRetries: 0 })));
  if (action === "extend") {
    const n = num(args.additional_match_limit);
    if (!n || n <= 0) throw new Error("additional_match_limit > 0 required");
    return wrap(args, opts, await client.beta.findall.extend(findall_id, { additional_match_limit: n }, req(opts, { maxRetries: 0 })));
  }
  if (action === "enrich") {
    const output_schema = jsonOutputSchema(args.output_schema);
    return wrap(
      args,
      opts,
      await client.beta.findall.enrich(
        findall_id,
        {
          output_schema,
          processor: str(args.processor),
          mcp_servers: parseJson(args.mcp_servers, "mcp_servers") as never,
          betas: betasFor(args),
        },
        req(opts, { maxRetries: 0 }),
      ),
    );
  }
  if (action === "events") {
    return wrap(args, opts, await collectStream(o => client.beta.findall.events(
      findall_id,
      { last_event_id: str(args.last_event_id), timeout: num(args.wait_seconds) ?? 15 },
      req(o),
    ), opts, num(args.wait_seconds) ?? 15, 40, str(args.last_event_id)));
  }
  throw new Error(`unknown findall action ${action}`);
}

export async function monitor(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  const action = str(args.action) || "list";
  const monitor_id = str(args.monitor_id);
  if (action === "list") {
    return wrap(
      args,
      opts,
      await client.monitor.list({ cursor: str(args.cursor), limit: num(args.limit) ?? 10, status: strs(args.status) as never }, req(opts)),
    );
  }
  if (action === "create") {
    const type = (str(args.type) as "event_stream" | "snapshot") || "event_stream";
    const frequency = str(args.frequency);
    if (!frequency) throw new Error("frequency required, e.g. 1h, 1d, 1w");
    let settings: Record<string, unknown>;
    if (type === "snapshot") {
      const task_run_id = str(args.task_run_id);
      if (!task_run_id) throw new Error("snapshot monitor needs task_run_id");
      settings = { task_run_id };
    } else {
      const query = str(args.query);
      if (!query) throw new Error("event_stream monitor needs query");
      const advanced: Record<string, unknown> = {};
      if (str(args.location)) advanced.location = args.location;
      const sp = sourcePolicy(args);
      if (sp) advanced.source_policy = sp;
      settings = { query, include_backfill: bool(args.include_backfill) };
      if (Object.keys(advanced).length) settings.advanced_settings = advanced;
      const schema = parseJson(args.output_schema, "output_schema");
      if (schema) settings.output_schema = schema;
    }
    const hook = webhook(args, "monitor");
    return wrap(
      args,
      opts,
      await client.monitor.create(
        {
          frequency,
          type,
          settings: settings as never,
          processor: (str(args.processor) as "lite" | "base") || "lite",
          memory_scope_key: str(args.memory_scope_key),
          metadata: parseJson(args.metadata, "metadata") as never,
          webhook: hook as never,
        },
        req(opts, { maxRetries: 0 }),
      ),
    );
  }
  if (!monitor_id) throw new Error("monitor_id required");
  if (action === "get") return wrap(args, opts, await client.monitor.retrieve(monitor_id, req(opts)));
  if (action === "cancel") return wrap(args, opts, await client.monitor.cancel(monitor_id, req(opts, { maxRetries: 0 })));
  if (action === "trigger") {
    await client.monitor.trigger(monitor_id, req(opts, { maxRetries: 0 }));
    return wrap(args, opts, { triggered: true, monitor_id });
  }
  if (action === "update") {
    for (const field of ["include_backfill", "output_schema", "task_run_id", "memory_scope_key"]) {
      if (args[field] !== undefined) throw new Error(`${field} is create-only for monitors`);
    }
    const body: Record<string, unknown> = {};
    if (str(args.frequency)) body.frequency = args.frequency;
    if (str(args.processor)) body.processor = args.processor;
    if (args.webhook_url === null) body.webhook = null;
    else if (args.webhook_url !== undefined) body.webhook = webhook(args, "monitor");
    if (args.metadata !== undefined) body.metadata = parseJson(args.metadata, "metadata");
    const settings: Record<string, unknown> = {};
    if (str(args.query)) settings.query = args.query;
    const advanced: Record<string, unknown> = {};
    if (str(args.location)) advanced.location = args.location;
    const sp = sourcePolicy(args);
    if (sp) advanced.source_policy = sp;
    if (Object.keys(advanced).length) settings.advanced_settings = advanced;
    if (Object.keys(settings).length) {
      body.type = "event_stream";
      body.settings = settings;
    }
    if (!Object.keys(body).length) throw new Error("update needs at least one field");
    return wrap(args, opts, await client.monitor.update(monitor_id, body as never, req(opts, { maxRetries: 0 })));
  }
  if (action === "events") {
    return wrap(
      args,
      opts,
      await client.monitor.events(
        monitor_id,
        {
          cursor: str(args.cursor),
          event_group_id: str(args.event_group_id),
          include_completions: bool(args.include_completions),
        },
        req(opts),
      ),
    );
  }
  throw new Error(`unknown monitor action ${action}`);
}

export async function memory(client: Parallel, args: ToolArgs, opts?: CallOpts): Promise<unknown> {
  const action = str(args.action) || "retrieve";
  const scope = { memory_scope_key: str(args.memory_scope_key) };
  if (action === "retrieve") {
    return wrap(
      args,
      opts,
      await client.beta.memory.retrieve(
        { ...scope, query: str(args.query), kind: str(args.kind) as never, limit: num(args.limit), since: str(args.since) },
        req(opts),
      ),
    );
  }
  if (action === "evict") {
    const id = str(args.id);
    const kind = str(args.kind) as "task" | "monitor" | "findall" | undefined;
    if (!id || !kind) throw new Error("evict needs id and kind task|monitor|findall");
    await client.beta.memory.evict({ id, kind, ...scope }, req(opts, { maxRetries: 0 }));
    return wrap(args, opts, { evicted: true, id, kind });
  }
  if (action === "clear") {
    await client.beta.memory.clear(scope, req(opts, { maxRetries: 0 }));
    return wrap(args, opts, { cleared: true, ...scope });
  }
  throw new Error(`unknown memory action ${action}`);
}

export { verifyWebhook };
