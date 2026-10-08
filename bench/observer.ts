/**
 * bench/observer.ts — neutral benchmark observation extension.
 *
 * Loaded identically in both arms (BENCH_ARM=E|C). It never mutates the
 * system prompt, never registers tools, and never injects tool-choice
 * advice. It records a JSONL event stream to BENCH_EVENTS and enforces the
 * frozen run limits by stopping the run with ctx.abort() + ctx.shutdown()
 * (never by throwing from a provider-request hook).
 *
 * Configuration (environment):
 *   BENCH_EVENTS          required  path of the JSONL event log
 *   BENCH_ARM             required  "E" (extension arm) or "C" (CLI arm)
 *   BENCH_RUN_ID          optional  run identifier embedded in every event id
 *   BENCH_MAX_REQUESTS    optional  model-request limit      (default 12)
 *   BENCH_MAX_TOOL_CALLS  optional  agent tool-call limit    (default 20)
 *   BENCH_MAX_TOKENS      optional  cumulative token limit   (default 150000)
 *   BENCH_MAX_OUTPUT      optional  per-response ceiling     (default 4096)
 *
 * Self-contained by contract: the bench mount contains only this file, so
 * only node builtins and type-only imports are allowed here.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ */
/* Frozen benchmark constants                                          */
/* ------------------------------------------------------------------ */

export interface BenchLimits {
  /** Maximum admitted model requests per run (initial + follow-up prompts). */
  maxRequests: number;
  /** Maximum agent tool calls per run (skill reads and shell calls included). */
  maxToolCalls: number;
  /** Cumulative token budget; admission stops once cumulative >= this value. */
  maxTotalTokens: number;
  /** Per-response output ceiling, applied via the provider-supported field. */
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: BenchLimits = {
  maxRequests: 12,
  maxToolCalls: 20,
  maxTotalTokens: 150_000,
  maxOutputTokens: 4096,
};

/** Ordinary default builtins; the observer adds no tools of its own. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

/** The nine pinned extension tools (treatment E only). */
export const PARALLEL_TOOLS = [
  "parallel_search",
  "parallel_extract",
  "parallel_responses",
  "parallel_task",
  "parallel_group",
  "parallel_findall",
  "parallel_monitor",
  "parallel_memory",
  "parallel_account",
] as const;

/**
 * Lazy-exposure condition. The six deferred tools start inactive under
 * BENCH_CONDITION=lazy and may appear after targeted activation. Historical
 * all-active builds included an activator; current all-active builds omit it.
 * The baseline audit accepts both so pinned experiments remain reproducible.
 */
export const ACTIVATOR_TOOL = "parallel_tools";
export const DEFERRED_TOOLS = [
  "parallel_task",
  "parallel_group",
  "parallel_findall",
  "parallel_monitor",
  "parallel_memory",
  "parallel_account",
] as const;

/** The ten pinned Pi-adapted CLI skills (treatment C only). */
export const PARALLEL_SKILLS = [
  "parallel-cli-setup",
  "parallel-data-enrichment",
  "parallel-deep-research",
  "parallel-findall",
  "parallel-memory",
  "parallel-monitor",
  "parallel-web-extract",
  "parallel-web-search",
  "result",
  "status",
] as const;

/** The one skill shared by both arms. */
export const SHARED_SKILL = "find-docs";

/** Exact shared task addendum, appended (never replacing) in both arms. */
export const NEUTRAL_ADDENDUM =
  "Complete the task using the resources available in this workspace. " +
  "Ground material factual claims in evidence you can inspect. " +
  "If essential information is missing, say what is missing. " +
  "Do not expose private data. " +
  "Do not make persistent account changes or create recurring services.";

/** Terse, tool-neutral limit notice (identical in both arms). */
export const LIMIT_NOTICE =
  "Benchmark run limit reached. Stop now and give your final answer from what you already have.";

export type BenchArm = "E" | "C";

/* ------------------------------------------------------------------ */
/* Redaction — credentials and hidden reasoning never reach the log    */
/* ------------------------------------------------------------------ */

const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const REDACTED = "[REDACTED]";

/** Collect non-trivial credential values from the environment. */
export function collectEnvSecrets(env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_KEY_PATTERN.test(key)) secrets.push(value);
  }
  return secrets;
}

/** Replace every occurrence of a known secret in an arbitrary string. */
export function redactString(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);

/**
 * Deep-copy a value for logging: secret values redacted, hidden-reasoning
 * content blocks dropped (replaced by a marker). Reasoning *configuration*
 * (for example a `{ effort }` option) is not reasoning output and is kept.
 */
export function redactForLog(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        THINKING_BLOCK_TYPES.has(String((item as { type?: unknown }).type))
      ) {
        out.push({ type: (item as { type: unknown }).type, redacted: true });
        continue;
      }
      out.push(redactForLog(item, secrets));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Provider reasoning replay metadata is hidden reasoning; never persist it.
      if (key === "reasoning_content" || key === "reasoning_details" || key === "thinkingSignature") {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactForLog(entry, secrets);
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Usage accounting — disjoint Pi usage fields only                    */
/* ------------------------------------------------------------------ */

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/**
 * Cumulative tokens from disjoint Pi usage fields only.
 * `reasoning` is a subset of `output` and `totalTokens` may double count;
 * neither is added here.
 */
export function usageTokens(usage: UsageLike | undefined): number {
  if (!usage) return 0;
  return (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

/* ------------------------------------------------------------------ */
/* Prompt audit                                                        */
/* ------------------------------------------------------------------ */

export interface AuditInput {
  systemPrompt: string;
  selectedTools: string[];
  skills: Array<{ name: string; filePath?: string; baseDir?: string }>;
  contextFiles: Array<{ path: string }>;
  appendSystemPrompt?: string;
  homeDir?: string;
}

export interface AuditResult {
  ok: boolean;
  failures: string[];
  tools: string[];
  skills: string[];
}

/** Expected effective resource list per arm. */
export function expectedResources(
  arm: BenchArm,
  condition: string = process.env.BENCH_CONDITION ?? "baseline",
): { tools: string[]; skillCount: number; skillNames: string[]; optionalTools: string[] } {
  if (arm === "E") {
    // Baseline requires the nine research tools and tolerates the activator,
    // so a round-1 build without it and a Tier 1 build with it both audit
    // clean. Lazy requires the three core tools plus the activator and
    // tolerates the deferred six, which appear only after activation.
    const required =
      condition === "lazy"
        ? [...BUILTIN_TOOLS, "parallel_search", "parallel_extract", "parallel_responses", ACTIVATOR_TOOL]
        : [...BUILTIN_TOOLS, ...PARALLEL_TOOLS];
    return {
      tools: [...required].sort(),
      skillCount: 1,
      skillNames: [SHARED_SKILL],
      optionalTools: condition === "lazy" ? [...DEFERRED_TOOLS] : [ACTIVATOR_TOOL],
    };
  }
  return {
    tools: [...BUILTIN_TOOLS].sort(),
    skillCount: PARALLEL_SKILLS.length + 1,
    skillNames: [SHARED_SKILL, ...PARALLEL_SKILLS].sort(),
    optionalTools: [],
  };
}

/**
 * Assert the effective prompt resources for an arm. Runs inside
 * before_agent_start, strictly before the first provider request.
 */
export function auditPrompt(
  arm: BenchArm,
  input: AuditInput,
  condition: string = process.env.BENCH_CONDITION ?? "baseline",
): AuditResult {
  const failures: string[] = [];
  const expected = expectedResources(arm, condition);
  const tools = [...input.selectedTools].sort();
  const skillNames = input.skills.map((skill) => skill.name).sort();

  const missingTools = expected.tools.filter((name) => !tools.includes(name));
  const permitted = new Set<string>([...expected.tools, ...expected.optionalTools]);
  const extraTools = tools.filter((name) => !permitted.has(name));
  if (missingTools.length > 0) failures.push(`missing_tools:${missingTools.join(",")}`);
  if (extraTools.length > 0) failures.push(`unexpected_tools:${extraTools.join(",")}`);

  if (input.skills.length !== expected.skillCount) {
    failures.push(`skill_count:${input.skills.length}!=${expected.skillCount}`);
  }
  if (!skillNames.includes(SHARED_SKILL)) failures.push(`missing_shared_skill:${SHARED_SKILL}`);
  const extraSkills = skillNames.filter((name) => !(expected.skillNames as string[]).includes(name));
  if (extraSkills.length > 0) failures.push(`unexpected_skills:${extraSkills.join(",")}`);

  // Cross-arm leakage.
  if (arm === "E") {
    const leaked = input.skills.filter((skill) =>
      (PARALLEL_SKILLS as readonly string[]).includes(skill.name) ||
      /parallel-cli|quarantined/i.test(`${skill.filePath ?? ""} ${skill.baseDir ?? ""}`),
    );
    if (leaked.length > 0) failures.push(`cross_arm_skills:${leaked.map((s) => s.name).join(",")}`);
  }
  const crossTools = tools.filter((name) => name.startsWith("parallel_"));
  if (arm === "C" && crossTools.length > 0) failures.push(`cross_arm_tools:${crossTools.join(",")}`);

  // No home guidance or other implicit context.
  if (input.contextFiles.length > 0) {
    failures.push(`context_files:${input.contextFiles.map((file) => file.path).join(",")}`);
  }
  const home = input.homeDir ?? homedir();
  if (home && home.length > 3 && input.systemPrompt.includes(home)) {
    failures.push(`home_path_in_prompt:${home}`);
  }

  // The shared addendum must be appended verbatim and must be the only
  // appended text. The observer itself never adds prompt content.
  const appended = (input.appendSystemPrompt ?? "").trim();
  if (appended !== NEUTRAL_ADDENDUM) failures.push("append_system_prompt_mismatch");

  return { ok: failures.length === 0, failures, tools, skills: skillNames };
}

/* ------------------------------------------------------------------ */
/* Observer                                                            */
/* ------------------------------------------------------------------ */

export interface ObserverOptions {
  eventsPath: string;
  arm: BenchArm;
  runId: string;
  limits: BenchLimits;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ObserverState {
  seq: number;
  promptIndex: number;
  requests: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; reasoning: number };
  costUsd: number;
  stopped: string | null;
  audit: AuditResult | null;
}

export interface Observer {
  state: ObserverState;
  attach(pi: ExtensionAPI): void;
  handlers: {
    beforeAgentStart(event: any, ctx: any): undefined;
    beforeProviderRequest(event: any, ctx: any): unknown;
    afterProviderResponse(event: any): void;
    input(event: any): void;
    turnStart(event: any): void;
    turnEnd(event: any): void;
    messageStart(event: any): void;
    messageEnd(event: any): void;
    toolCall(event: any, ctx: any): { block: boolean; reason: string } | undefined;
    toolExecutionEnd(event: any): void;
    agentEnd(): void;
    sessionShutdown(): void;
  };
}

export function createObserver(options: ObserverOptions): Observer {
  const { eventsPath, arm, runId, limits } = options;
  const secrets = collectEnvSecrets(options.env ?? process.env);
  const homeDir = options.homeDir ?? homedir();

  const state: ObserverState = {
    seq: 0,
    promptIndex: 0,
    requests: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 },
    costUsd: 0,
    stopped: null,
    audit: null,
  };

  // Monotonic clock: performance.now() is the monotonic source; the wall
  // timestamp is derived from it so both advance together.
  const wallOffset = Date.now() - performance.now();
  mkdirSync(dirname(eventsPath), { recursive: true });

  const write = (type: string, fields: Record<string, unknown> = {}) => {
    state.seq += 1;
    const mono = performance.now();
    const record = {
      id: `${runId}:${state.seq}`,
      run: runId,
      arm,
      seq: state.seq,
      mono: Math.round(mono * 1000) / 1000,
      ts: new Date(wallOffset + mono).toISOString(),
      type,
      ...fields,
    };
    appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  };

  const counters = () => ({
    requests: state.requests,
    tool_calls: state.toolCalls,
    tokens: { ...state.tokens },
    cost_usd: state.costUsd,
  });

  /** Stop the run without throwing: abort the agent and shut pi down. */
  const guardStop = (ctx: any, reason: string, extra: Record<string, unknown> = {}) => {
    if (state.stopped) {
      write("guard_hold", { reason, original_stop: state.stopped });
    } else {
      state.stopped = reason;
      write("guard_stop", { reason, ...counters(), ...extra });
    }
    try { ctx.abort(); } catch { /* best effort */ }
    try { ctx.shutdown(); } catch { /* best effort */ }
  };

  write("observer_start", {
    limits: { ...limits },
    cwd: process.cwd(),
    pid: process.pid,
    observer_mutates_prompt: false,
    observer_registers_tools: false,
  });

  const handlers: Observer["handlers"] = {
    beforeAgentStart(event: any, ctx: any): undefined {
      state.promptIndex += 1;
      if (state.stopped) {
        write("guard_hold", { reason: "before_agent_start_after_stop", original_stop: state.stopped, prompt_index: state.promptIndex });
        try { ctx.abort(); } catch { /* best effort */ }
        try { ctx.shutdown(); } catch { /* best effort */ }
        return undefined;
      }
      const opts = event.systemPromptOptions ?? {};
      const systemPrompt = String(event.systemPrompt ?? "");
      const audit = auditPrompt(arm, {
        systemPrompt,
        selectedTools: Array.isArray(opts.selectedTools) ? opts.selectedTools.map(String) : [],
        skills: Array.isArray(opts.skills)
          ? opts.skills.map((s: any) => ({ name: String(s?.name ?? ""), filePath: s?.filePath, baseDir: s?.baseDir }))
          : [],
        contextFiles: Array.isArray(opts.contextFiles)
          ? opts.contextFiles.map((f: any) => ({ path: String(f?.path ?? "") }))
          : [],
        appendSystemPrompt: typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : undefined,
        homeDir,
      });
      if (state.promptIndex === 1) state.audit = audit;
      write("prompt_audit", {
        prompt_index: state.promptIndex,
        ok: audit.ok,
        failures: audit.failures,
        tools: audit.tools,
        skills: audit.skills,
        context_files: (opts.contextFiles ?? []).map((f: any) => String(f?.path ?? "")),
        system_prompt_sha256: createHash("sha256").update(systemPrompt).digest("hex"),
        system_prompt: redactForLog(systemPrompt, secrets),
        append_system_prompt: redactForLog(opts.appendSystemPrompt ?? null, secrets),
        user_prompt: redactForLog(event.prompt ?? "", secrets),
      });
      // A contaminated treatment invalidates the run; stop before the first
      // network call rather than spend budget on it.
      if (!audit.ok) guardStop(ctx, "prompt_audit_failed", { failures: audit.failures });
      return undefined;
    },

    beforeProviderRequest(event: any, ctx: any): unknown {
      if (state.stopped) {
        guardStop(ctx, `provider_request_after_stop`);
        return undefined;
      }
      if (state.requests + 1 > limits.maxRequests) {
        guardStop(ctx, `model_request_limit:${limits.maxRequests}`, { attempted_request: state.requests + 1 });
        return undefined;
      }
      if (state.tokens.total >= limits.maxTotalTokens) {
        guardStop(ctx, `token_limit:${limits.maxTotalTokens}`, { attempted_request: state.requests + 1 });
        return undefined;
      }
      state.requests += 1;

      const payload = (event.payload ?? {}) as Record<string, unknown>;
      // Responses-API payloads (Codex route: `input` + `instructions`, no
      // `messages`) do not accept the completions-API ceiling field and the
      // Codex adapter rejects unknown parameters outright. Round 2 is bounded
      // by wall clock, so pass these through unmodified and record that no
      // output cap was applied rather than break the request.
      const responsesShape = Array.isArray(payload.input) && !("messages" in payload);
      if (responsesShape) {
        write("provider_request", {
          request_index: state.requests,
          model: payload.model,
          payload: redactForLog(payload, secrets),
          output_cap: { field: null, value: null, previous: null, note: "responses_api_shape_no_cap_applied" },
          ...counters(),
        });
        return payload;
      }
      // Output ceiling. The pinned Fireworks route uses the
      // openai-completions API shape, whose pi-ai serializer emits
      // `max_completion_tokens` (verified against installed pi-ai 0.86.x:
      // fireworks is not in the max_tokens provider list). If a payload ever
      // arrives with only the legacy field, cap that field and flag it.
      const hasCompletion = "max_completion_tokens" in payload;
      const hasLegacy = "max_tokens" in payload;
      const capField = hasLegacy && !hasCompletion ? "max_tokens" : "max_completion_tokens";
      const existing = typeof payload[capField] === "number" ? (payload[capField] as number) : undefined;
      const cap = Math.min(existing ?? limits.maxOutputTokens, limits.maxOutputTokens);

      write("provider_request", {
        request_index: state.requests,
        model: payload.model,
        payload: redactForLog(payload, secrets),
        output_cap: { field: capField, value: cap, previous: existing ?? null },
        ...(capField === "max_tokens" ? { warning: "payload used legacy max_tokens shape" } : {}),
        ...counters(),
      });
      return { ...payload, [capField]: cap };
    },

    afterProviderResponse(event: any): void {
      write("provider_response", { request_index: state.requests, status: event.status });
    },

    input(event: any): void {
      write("input", { text: redactForLog(event.text ?? "", secrets), source: event.source ?? null });
    },

    turnStart(event: any): void {
      write("turn_start", { turn_index: event.turnIndex ?? null });
    },

    turnEnd(event: any): void {
      write("turn_end", {
        turn_index: event.turnIndex ?? null,
        tool_results: Array.isArray(event.toolResults) ? event.toolResults.length : null,
      });
    },

    messageStart(event: any): void {
      write("message_start", { role: event.message?.role ?? null });
    },

    messageEnd(event: any): void {
      const message = event.message ?? {};
      const usage: UsageLike | undefined = message.role === "assistant" ? message.usage : undefined;
      if (usage) {
        state.tokens.input += usage.input || 0;
        state.tokens.output += usage.output || 0;
        state.tokens.cacheRead += usage.cacheRead || 0;
        state.tokens.cacheWrite += usage.cacheWrite || 0;
        state.tokens.total += usageTokens(usage);
        state.tokens.reasoning += usage.reasoning || 0;
        state.costUsd += usage.cost?.total || 0;
      }
      write("message_end", {
        role: message.role ?? null,
        stop_reason: message.stopReason ?? null,
        usage: usage ? redactForLog(usage, secrets) : null,
        message_tokens: usageTokens(usage),
        ...counters(),
      });
    },

    toolCall(event: any, ctx: any): { block: boolean; reason: string } | undefined {
      if (state.stopped) {
        guardStop(ctx, "tool_call_after_stop");
        return { block: true, reason: LIMIT_NOTICE };
      }
      if (state.toolCalls + 1 > limits.maxToolCalls) {
        guardStop(ctx, `tool_call_limit:${limits.maxToolCalls}`, { attempted_tool_call: state.toolCalls + 1 });
        return { block: true, reason: LIMIT_NOTICE };
      }
      state.toolCalls += 1;
      write("tool_call", {
        tool: event.toolName,
        tool_call_id: event.toolCallId ?? null,
        tool_call_index: state.toolCalls,
        input: redactForLog(event.input ?? event.args ?? null, secrets),
        ...counters(),
      });
      return undefined;
    },

    toolExecutionEnd(event: any): void {
      const result = event.result ?? {};
      write("tool_execution_end", {
        tool: event.toolName,
        tool_call_id: event.toolCallId ?? null,
        is_error: event.isError === true,
        output: redactForLog(result.content ?? null, secrets),
      });
    },

    agentEnd(): void {
      write("run_end", {
        outcome: state.stopped ? "limit_stop" : "completed",
        stop_reason: state.stopped,
        prompt_index: state.promptIndex,
        ...counters(),
      });
    },

    sessionShutdown(): void {
      write("observer_summary", {
        audit_ok: state.audit ? state.audit.ok : null,
        audit_failures: state.audit?.failures ?? [],
        stopped: state.stopped,
        prompts: state.promptIndex,
        ...counters(),
      });
    },
  };

  return {
    state,
    handlers,
    attach(pi: ExtensionAPI): void {
      pi.on("before_agent_start", (event, ctx) => handlers.beforeAgentStart(event, ctx));
      pi.on("before_provider_request", (event, ctx) => handlers.beforeProviderRequest(event, ctx) as any);
      pi.on("after_provider_response", (event) => handlers.afterProviderResponse(event));
      pi.on("input", (event) => { handlers.input(event); });
      pi.on("turn_start", (event) => handlers.turnStart(event));
      pi.on("turn_end", (event) => handlers.turnEnd(event));
      pi.on("message_start", (event) => handlers.messageStart(event));
      pi.on("message_end", (event) => handlers.messageEnd(event));
      pi.on("tool_call", (event, ctx) => handlers.toolCall(event, ctx));
      pi.on("tool_execution_end", (event) => handlers.toolExecutionEnd(event));
      pi.on("agent_end", () => handlers.agentEnd());
      pi.on("session_shutdown", () => handlers.sessionShutdown());
    },
  };
}

/* ------------------------------------------------------------------ */
/* Events-file summary (recompute counters from the log)               */
/* ------------------------------------------------------------------ */

export interface EventsSummary {
  events: number;
  requests: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; reasoning: number };
  guardStop: { reason: string; id: string } | null;
  runEnds: Array<{ outcome: string; stop_reason: string | null; id: string }>;
  audits: Array<{ ok: boolean; failures: string[]; id: string }>;
}

export function summarizeEvents(lines: string[]): EventsSummary {
  const summary: EventsSummary = {
    events: 0,
    requests: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 },
    guardStop: null,
    runEnds: [],
    audits: [],
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed);
    summary.events += 1;
    if (record.type === "provider_request") summary.requests += 1;
    if (record.type === "tool_call") summary.toolCalls += 1;
    if (record.type === "message_end" && record.usage) {
      summary.tokens.input += record.usage.input || 0;
      summary.tokens.output += record.usage.output || 0;
      summary.tokens.cacheRead += record.usage.cacheRead || 0;
      summary.tokens.cacheWrite += record.usage.cacheWrite || 0;
      summary.tokens.total += usageTokens(record.usage);
      summary.tokens.reasoning += record.usage.reasoning || 0;
    }
    if (record.type === "guard_stop" && !summary.guardStop) {
      summary.guardStop = { reason: record.reason, id: record.id };
    }
    if (record.type === "run_end") {
      summary.runEnds.push({ outcome: record.outcome, stop_reason: record.stop_reason ?? null, id: record.id });
    }
    if (record.type === "prompt_audit") {
      summary.audits.push({ ok: record.ok === true, failures: record.failures ?? [], id: record.id });
    }
  }
  return summary;
}

export function summarizeEventsFile(path: string): EventsSummary {
  return summarizeEvents(readFileSync(path, "utf8").split("\n"));
}

/* ------------------------------------------------------------------ */
/* Configuration and default export                                    */
/* ------------------------------------------------------------------ */

export interface ObserverConfig extends ObserverOptions {}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`bench observer: ${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Validate and load observer configuration from an environment map. */
export function loadObserverConfig(env: NodeJS.ProcessEnv): ObserverConfig {
  const eventsPath = env.BENCH_EVENTS;
  if (!eventsPath) throw new Error("bench observer: BENCH_EVENTS is required");
  const arm = env.BENCH_ARM;
  if (arm !== "E" && arm !== "C") {
    throw new Error(`bench observer: BENCH_ARM must be "E" or "C", got ${JSON.stringify(arm)}`);
  }
  return {
    eventsPath,
    arm,
    runId: env.BENCH_RUN_ID || "run",
    limits: {
      maxRequests: intEnv(env, "BENCH_MAX_REQUESTS", DEFAULT_LIMITS.maxRequests),
      maxToolCalls: intEnv(env, "BENCH_MAX_TOOL_CALLS", DEFAULT_LIMITS.maxToolCalls),
      maxTotalTokens: intEnv(env, "BENCH_MAX_TOKENS", DEFAULT_LIMITS.maxTotalTokens),
      maxOutputTokens: intEnv(env, "BENCH_MAX_OUTPUT", DEFAULT_LIMITS.maxOutputTokens),
    },
    env,
  };
}

export default function (pi: ExtensionAPI) {
  const config = loadObserverConfig(process.env);
  createObserver(config).attach(pi);
}
