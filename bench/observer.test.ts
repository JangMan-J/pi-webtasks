/**
 * Offline acceptance checks for bench/observer.ts. No paid endpoints, no
 * network: the provider path runs against a mock transport through the
 * installed pi-ai serializer, and the cancellation-gate test drives the
 * installed Pi ExtensionRunner (real hook dispatch, real abort wiring).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_TOOLS,
  DEFAULT_LIMITS,
  LIMIT_NOTICE,
  NEUTRAL_ADDENDUM,
  PARALLEL_SKILLS,
  PARALLEL_TOOLS,
  SHARED_SKILL,
  auditPrompt,
  createObserver,
  expectedResources,
  loadObserverConfig,
  redactForLog,
  summarizeEvents,
  usageTokens,
  type BenchArm,
  type Observer,
} from "./observer.ts";
import { createMockFetch, runChatRequest } from "./mock-provider.ts";

const HOME = "/home/benchuser";

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-observer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skill(name: string, base = "/opt/bench/skills") {
  return { name, filePath: `${base}/${name}/SKILL.md`, baseDir: `${base}/${name}` };
}

function agentStartEvent(arm: BenchArm, mutate: (event: any) => void = () => {}): any {
  const event = {
    prompt: "Benchmark task prompt.",
    systemPrompt: `You are a coding assistant.\n\n${NEUTRAL_ADDENDUM}`,
    systemPromptOptions: {
      cwd: "/work",
      selectedTools: [...expectedResources(arm).tools],
      skills:
        arm === "E"
          ? [skill(SHARED_SKILL)]
          : [SHARED_SKILL, ...PARALLEL_SKILLS].map((name) => skill(name)),
      contextFiles: [] as Array<{ path: string }>,
      appendSystemPrompt: NEUTRAL_ADDENDUM,
    },
  };
  mutate(event);
  return event;
}

function makeObserver(
  t: test.TestContext,
  arm: BenchArm,
  overrides: Partial<Parameters<typeof createObserver>[0]> = {},
): { observer: Observer; eventsPath: string; readEvents: () => any[] } {
  const eventsPath = join(tempDir(t), "events.jsonl");
  const observer = createObserver({
    eventsPath,
    arm,
    runId: "test-run",
    limits: { ...DEFAULT_LIMITS },
    env: {},
    homeDir: HOME,
    ...overrides,
  });
  const readEvents = () =>
    readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { observer, eventsPath, readEvents };
}

function mockCtx() {
  const calls = { abort: 0, shutdown: 0 };
  const controller = new AbortController();
  return {
    calls,
    controller,
    ctx: {
      abort: () => {
        calls.abort += 1;
        controller.abort();
      },
      shutdown: () => {
        calls.shutdown += 1;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

test("loadObserverConfig requires BENCH_EVENTS and a valid arm", () => {
  assert.throws(() => loadObserverConfig({}), /BENCH_EVENTS is required/);
  assert.throws(
    () => loadObserverConfig({ BENCH_EVENTS: "/tmp/e.jsonl", BENCH_ARM: "X" }),
    /BENCH_ARM must be "E" or "C"/,
  );
  const config = loadObserverConfig({ BENCH_EVENTS: "/tmp/e.jsonl", BENCH_ARM: "C" });
  assert.equal(config.arm, "C");
  assert.deepEqual(config.limits, DEFAULT_LIMITS);
  const tuned = loadObserverConfig({
    BENCH_EVENTS: "/tmp/e.jsonl",
    BENCH_ARM: "E",
    BENCH_RUN_ID: "r1",
    BENCH_MAX_REQUESTS: "3",
  });
  assert.equal(tuned.runId, "r1");
  assert.equal(tuned.limits.maxRequests, 3);
  assert.throws(
    () => loadObserverConfig({ BENCH_EVENTS: "/tmp/e.jsonl", BENCH_ARM: "E", BENCH_MAX_TOKENS: "nope" }),
    /BENCH_MAX_TOKENS/,
  );
});

/* ------------------------------------------------------------------ */
/* Prompt audit                                                        */
/* ------------------------------------------------------------------ */

test("audit E passes: 4 builtins + 9 Parallel tools, exactly the shared skill", () => {
  const event = agentStartEvent("E");
  const audit = auditPrompt("E", {
    systemPrompt: event.systemPrompt,
    selectedTools: event.systemPromptOptions.selectedTools,
    skills: event.systemPromptOptions.skills,
    contextFiles: [],
    appendSystemPrompt: NEUTRAL_ADDENDUM,
    homeDir: HOME,
  });
  assert.equal(audit.ok, true, audit.failures.join("; "));
  assert.equal(audit.tools.length, BUILTIN_TOOLS.length + PARALLEL_TOOLS.length);
});

test("audit C passes: 4 builtins only, 10 Parallel skills + shared find-docs", () => {
  const event = agentStartEvent("C");
  const audit = auditPrompt("C", {
    systemPrompt: event.systemPrompt,
    selectedTools: event.systemPromptOptions.selectedTools,
    skills: event.systemPromptOptions.skills,
    contextFiles: [],
    appendSystemPrompt: NEUTRAL_ADDENDUM,
    homeDir: HOME,
  });
  assert.equal(audit.ok, true, audit.failures.join("; "));
  assert.equal(audit.skills.length, 11);
});

test("audit rejects missing shared skill, extra tools, and cross-arm leakage", () => {
  const base = agentStartEvent("E");
  const opts = base.systemPromptOptions;
  const run = () =>
    auditPrompt("E", {
      systemPrompt: base.systemPrompt,
      selectedTools: opts.selectedTools,
      skills: opts.skills,
      contextFiles: opts.contextFiles,
      appendSystemPrompt: opts.appendSystemPrompt,
      homeDir: HOME,
    });

  opts.skills = [];
  assert.ok(run().failures.some((f) => f.startsWith("missing_shared_skill")));
  opts.skills = [skill(SHARED_SKILL), skill("parallel-web-search", "/opt/bench/parallel-cli")];
  const leaked = run();
  assert.ok(leaked.failures.some((f) => f.startsWith("cross_arm_skills")));
  assert.ok(leaked.failures.some((f) => f.startsWith("skill_count")));
  opts.skills = [skill(SHARED_SKILL)];

  opts.selectedTools = [...opts.selectedTools, "grep"];
  assert.ok(run().failures.some((f) => f.startsWith("unexpected_tools:grep")));
  opts.selectedTools = opts.selectedTools.filter((t: string) => t !== "grep" && t !== "parallel_search");
  assert.ok(run().failures.some((f) => f.startsWith("missing_tools:parallel_search")));

  opts.contextFiles = [{ path: `${HOME}/AGENTS.md` }];
  assert.ok(run().failures.some((f) => f.startsWith("context_files:")));
  opts.contextFiles = [];

  opts.appendSystemPrompt = `${NEUTRAL_ADDENDUM} Prefer parallel_search for research.`;
  assert.ok(run().failures.includes("append_system_prompt_mismatch"));
});

test("audit rejects Parallel tools and home paths in arm C", () => {
  const event = agentStartEvent("C");
  const opts = event.systemPromptOptions;
  opts.selectedTools = [...opts.selectedTools, "parallel_search"];
  let audit = auditPrompt("C", {
    systemPrompt: event.systemPrompt,
    selectedTools: opts.selectedTools,
    skills: opts.skills,
    contextFiles: [],
    appendSystemPrompt: NEUTRAL_ADDENDUM,
    homeDir: HOME,
  });
  assert.ok(audit.failures.some((f) => f.startsWith("cross_arm_tools:parallel_search")));

  audit = auditPrompt("C", {
    systemPrompt: `guidance from ${HOME}/AGENTS.md\n${NEUTRAL_ADDENDUM}`,
    selectedTools: [...BUILTIN_TOOLS],
    skills: agentStartEvent("C").systemPromptOptions.skills,
    contextFiles: [],
    appendSystemPrompt: NEUTRAL_ADDENDUM,
    homeDir: HOME,
  });
  assert.ok(audit.failures.some((f) => f.startsWith("home_path_in_prompt")));
});

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

test("redaction removes credentials and hidden reasoning, keeps config", () => {
  const secrets = ["sk-test-secret-value-123"];
  const payload = {
    model: "m",
    reasoning_effort: "high",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning about sk-test-secret-value-123" },
          { type: "text", text: "visible answer" },
        ],
        reasoning_content: "provider replay reasoning",
      },
      { role: "user", content: "key is sk-test-secret-value-123" },
    ],
  };
  const redacted = redactForLog(payload, secrets) as any;
  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes("sk-test-secret-value-123"));
  assert.ok(!serialized.includes("secret reasoning"));
  assert.ok(serialized.includes("[REDACTED]"));
  assert.equal(redacted.reasoning_effort, "high");
  assert.deepEqual(redacted.messages[0].content, [
    { type: "thinking", redacted: true },
    { type: "text", text: "visible answer" },
  ]);
});

/* ------------------------------------------------------------------ */
/* Usage accounting                                                    */
/* ------------------------------------------------------------------ */

test("usage counters sum disjoint fields only; reasoning is not double counted", (t) => {
  const { observer } = makeObserver(t, "E");
  observer.handlers.messageEnd({
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 5, totalTokens: 999, cost: { total: 0.01 } },
    },
  });
  assert.equal(usageTokens({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }), 20);
  assert.equal(observer.state.tokens.total, 20);
  assert.equal(observer.state.tokens.reasoning, 5);
  assert.equal(observer.state.costUsd, 0.01);
});

/* ------------------------------------------------------------------ */
/* Event stream shape                                                  */
/* ------------------------------------------------------------------ */

test("events carry unique ids and monotonic timestamps", (t) => {
  const { observer, readEvents } = makeObserver(t, "C");
  const { ctx } = mockCtx();
  observer.handlers.input({ text: "hello", source: "interactive" });
  observer.handlers.turnStart({ turnIndex: 0 });
  observer.handlers.toolCall({ toolName: "read", toolCallId: "t1", input: { path: "/x" } }, ctx);
  observer.handlers.agentEnd();
  observer.handlers.sessionShutdown();
  const events = readEvents();
  const ids = events.map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length);
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i].seq > events[i - 1].seq);
    assert.ok(events[i].mono >= events[i - 1].mono);
  }
  assert.ok(events.every((event) => event.run === "test-run" && event.arm === "C" && typeof event.ts === "string"));
  assert.equal(events.at(-1).type, "observer_summary");
  assert.equal(events.at(-2).outcome, "completed");
});

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

test("tool-call limit blocks the 21st call with the neutral notice", (t) => {
  const { observer, readEvents } = makeObserver(t, "E", {
    limits: { ...DEFAULT_LIMITS, maxToolCalls: 20 },
  });
  const { ctx, calls } = mockCtx();
  for (let i = 1; i <= 20; i += 1) {
    assert.equal(observer.handlers.toolCall({ toolName: "bash", toolCallId: `t${i}`, input: {} }, ctx), undefined);
  }
  const blocked = observer.handlers.toolCall({ toolName: "bash", toolCallId: "t21", input: {} }, ctx);
  assert.deepEqual(blocked, { block: true, reason: LIMIT_NOTICE });
  assert.equal(calls.abort, 1);
  assert.equal(calls.shutdown, 1);
  const stop = readEvents().find((event) => event.type === "guard_stop");
  assert.equal(stop.reason, "tool_call_limit:20");
  // The notice must not steer tool choice.
  assert.ok(!/parallel|search|extract|research|cli|skill/i.test(LIMIT_NOTICE));
});

test("cumulative token limit stops admission of the next request", (t) => {
  const { observer, readEvents } = makeObserver(t, "E", {
    limits: { ...DEFAULT_LIMITS, maxTotalTokens: 100 },
  });
  observer.handlers.messageEnd({
    message: { role: "assistant", stopReason: "stop", usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } },
  });
  const { ctx, calls } = mockCtx();
  const result = observer.handlers.beforeProviderRequest({ payload: { model: "m" } }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.abort, 1);
  assert.equal(calls.shutdown, 1);
  assert.equal(observer.state.requests, 0);
  const stop = readEvents().find((event) => event.type === "guard_stop");
  assert.equal(stop.reason, "token_limit:100");
});

test("after a stop, later prompts and requests are held, never re-admitted", (t) => {
  const { observer, readEvents } = makeObserver(t, "E", {
    limits: { ...DEFAULT_LIMITS, maxRequests: 1 },
  });
  const first = mockCtx();
  observer.handlers.beforeProviderRequest({ payload: { model: "m" } }, first.ctx);
  const second = mockCtx();
  observer.handlers.beforeProviderRequest({ payload: { model: "m" } }, second.ctx);
  assert.equal(observer.state.stopped, "model_request_limit:1");
  // Follow-up prompt in the same process: held before any provider call.
  const third = mockCtx();
  observer.handlers.beforeAgentStart(agentStartEvent("E"), third.ctx);
  assert.equal(third.calls.abort, 1);
  assert.equal(third.calls.shutdown, 1);
  const holds = readEvents().filter((event) => event.type === "guard_hold");
  assert.ok(holds.length >= 1);
  observer.handlers.agentEnd();
  assert.equal(readEvents().find((event) => event.type === "run_end").outcome, "limit_stop");
});

/* ------------------------------------------------------------------ */
/* Prompt audit gate: failure captured before the first network call   */
/* ------------------------------------------------------------------ */

test("a failed audit is recorded and stops the run before any dispatch", async (t) => {
  const { observer, readEvents } = makeObserver(t, "E");
  const bad = agentStartEvent("E", (event) => {
    event.systemPromptOptions.skills = [];
  });
  const startCtx = mockCtx();
  observer.handlers.beforeAgentStart(bad, startCtx.ctx);
  assert.equal(startCtx.calls.abort, 1);

  const controller = new AbortController();
  const mock = createMockFetch();
  const requestCtx = mockCtx();
  const message = await runChatRequest({
    signal: controller.signal,
    fetch: mock.fetch,
    onPayload: (payload) => {
      const result = observer.handlers.beforeProviderRequest({ payload }, {
        abort: () => { requestCtx.calls.abort += 1; controller.abort(); },
        shutdown: requestCtx.ctx.shutdown,
      });
      return result;
    },
  });
  assert.equal(message.stopReason, "aborted");
  assert.equal(mock.dispatched, 0, "no provider request may be dispatched after a failed audit");

  const events = readEvents();
  const audit = events.find((event) => event.type === "prompt_audit");
  const stop = events.find((event) => event.type === "guard_stop");
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((f: string) => f.startsWith("missing_shared_skill")));
  assert.equal(stop.reason, "prompt_audit_failed");
  assert.ok(audit.seq < stop.seq, "audit failure is captured before the stop");
  assert.ok(!events.some((event) => event.type === "provider_request"));
});

/* ------------------------------------------------------------------ */
/* Real provider path: output ceiling and the request-13 gate          */
/* ------------------------------------------------------------------ */

test("Fireworks payload uses max_completion_tokens; the 4096 ceiling is applied", async (t) => {
  const { observer, readEvents } = makeObserver(t, "E");
  const { ctx } = mockCtx();
  const mock = createMockFetch();
  const message = await runChatRequest({
    signal: new AbortController().signal,
    fetch: mock.fetch,
    onPayload: (payload) => observer.handlers.beforeProviderRequest({ payload }, ctx),
  });
  assert.equal(message.stopReason, "stop");
  assert.equal(mock.dispatched, 1);
  const body = mock.calls[0].body;
  assert.equal(body.max_completion_tokens, 4096, "installed serializer must emit the Fireworks shape, capped");
  assert.equal(body.max_tokens, undefined, "legacy max_tokens must not appear on this route");
  const record = readEvents().find((event) => event.type === "provider_request");
  assert.equal(record.output_cap.field, "max_completion_tokens");
  assert.equal(record.output_cap.value, 4096);
  assert.equal(record.warning, undefined);
});

test("request 13 is never dispatched through the installed Pi hook dispatch and abort gate", async (t) => {
  const dir = tempDir(t);
  const eventsPath = join(dir, "events.jsonl");

  // Drive the real installed extension pipeline: jiti load of observer.ts,
  // the real ExtensionRunner.emitBeforeProviderRequest, and contextActions
  // abort/shutdown wired to a real AbortController — the same path the agent
  // session uses, ending in pi-ai's signal-gated dispatch.
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  process.env.BENCH_EVENTS = eventsPath;
  process.env.BENCH_ARM = "E";
  process.env.BENCH_RUN_ID = "gate-test";

  const packageEntry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname;
  const dist = join(packageEntry, "..");
  const loader = await import(join(dist, "core", "extensions", "loader.js"));
  const runnerModule = await import(join(dist, "core", "extensions", "runner.js"));

  const runtime = loader.createExtensionRuntime();
  const observerPath = new URL("./observer.ts", import.meta.url).pathname;
  const loaded = await loader.loadExtensions([observerPath], dir, undefined, runtime);
  assert.deepEqual(loaded.errors, []);

  const controller = new AbortController();
  let shutdowns = 0;
  const runner = new runnerModule.ExtensionRunner(loaded.extensions, runtime, dir, {}, {});
  runner.bindCore(
    {},
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => controller.signal,
      abort: () => controller.abort(),
      hasPendingMessages: () => false,
      shutdown: () => { shutdowns += 1; },
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    },
  );

  const mock = createMockFetch();
  let final: any;
  for (let i = 1; i <= 13; i += 1) {
    final = await runChatRequest({
      signal: controller.signal,
      fetch: mock.fetch,
      onPayload: (payload) => runner.emitBeforeProviderRequest(payload),
    });
    if (i <= 12) assert.equal(final.stopReason, "stop", `request ${i} should complete`);
  }
  assert.equal(final.stopReason, "aborted", "the 13th request ends via the abort path, not an error");
  assert.equal(mock.dispatched, 12, "request 13 must never reach the transport");
  assert.ok(mock.calls.every((call, index) => index < 12 || call.abortedAtEntry));
  assert.ok(shutdowns >= 1, "ctx.shutdown must be requested");

  const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const requests = events.filter((event) => event.type === "provider_request");
  assert.equal(requests.length, 12);
  const stop = events.find((event) => event.type === "guard_stop");
  assert.equal(stop.reason, "model_request_limit:12");
  assert.equal(stop.attempted_request, 13);
});

/* ------------------------------------------------------------------ */
/* Events-file summary                                                 */
/* ------------------------------------------------------------------ */

test("summarizeEvents recomputes counters from the log", (t) => {
  const { observer, eventsPath } = makeObserver(t, "E", {
    limits: { ...DEFAULT_LIMITS, maxRequests: 2 },
  });
  const ctxPair = mockCtx();
  observer.handlers.beforeAgentStart(agentStartEvent("E"), ctxPair.ctx);
  observer.handlers.beforeProviderRequest({ payload: { model: "m" } }, ctxPair.ctx);
  observer.handlers.messageEnd({
    message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
  });
  observer.handlers.beforeProviderRequest({ payload: { model: "m" } }, ctxPair.ctx);
  observer.handlers.toolCall({ toolName: "read", toolCallId: "a", input: {} }, ctxPair.ctx);
  observer.handlers.beforeProviderRequest({ payload: { model: "m" } }, ctxPair.ctx);
  observer.handlers.agentEnd();
  observer.handlers.sessionShutdown();

  const summary = summarizeEvents(readFileSync(eventsPath, "utf8").split("\n"));
  assert.equal(summary.requests, 2);
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.tokens.total, 10);
  assert.equal(summary.guardStop?.reason, "model_request_limit:2");
  assert.equal(summary.audits.length, 1);
  assert.equal(summary.audits[0].ok, true);
  assert.deepEqual(summary.runEnds.map((end) => end.outcome), ["limit_stop"]);
});

test("lazy condition: core tools required, deferred tools tolerated after activation", () => {
  const expected = expectedResources("E", "lazy");
  assert.deepEqual(expected.tools, [...BUILTIN_TOOLS, "parallel_extract", "parallel_responses", "parallel_search", "parallel_tools"].sort());
  assert.deepEqual([...expected.optionalTools].sort(), ["parallel_account", "parallel_findall", "parallel_group", "parallel_memory", "parallel_monitor", "parallel_task"]);

  const base = {
    systemPrompt: `You are a coding assistant.\n\n${NEUTRAL_ADDENDUM}`,
    skills: [{ name: SHARED_SKILL, filePath: `/opt/bench/skills/${SHARED_SKILL}/SKILL.md`, baseDir: `/opt/bench/skills/${SHARED_SKILL}` }],
    contextFiles: [] as Array<{ path: string }>,
    appendSystemPrompt: NEUTRAL_ADDENDUM,
    homeDir: HOME,
  };

  // Before activation.
  const start = auditPrompt("E", { ...base, selectedTools: [...expected.tools] }, "lazy");
  assert.equal(start.ok, true, start.failures.join("; "));

  // After the agent activates the deferred set, a later prompt audit still passes.
  const activated = auditPrompt("E", { ...base, selectedTools: [...expected.tools, ...expected.optionalTools] }, "lazy");
  assert.equal(activated.ok, true, activated.failures.join("; "));

  // A missing core tool is still a failure, so the relaxation is not blanket.
  const broken = auditPrompt("E", { ...base, selectedTools: expected.tools.filter(name => name !== "parallel_search") }, "lazy");
  assert.equal(broken.ok, false);
  assert.ok(broken.failures.some(failure => failure.startsWith("missing_tools:")));
});

test("baseline condition still demands all nine research tools", () => {
  const expected = expectedResources("E", "baseline");
  assert.equal(expected.tools.length, BUILTIN_TOOLS.length + PARALLEL_TOOLS.length);
  assert.deepEqual(expected.optionalTools, ["parallel_tools"]);
  const audit = auditPrompt("E", {
    systemPrompt: `You are a coding assistant.\n\n${NEUTRAL_ADDENDUM}`,
    selectedTools: [...BUILTIN_TOOLS, "parallel_search", "parallel_extract", "parallel_responses"],
    skills: [{ name: SHARED_SKILL, filePath: `/opt/bench/skills/${SHARED_SKILL}/SKILL.md`, baseDir: `/opt/bench/skills/${SHARED_SKILL}` }],
    contextFiles: [],
    appendSystemPrompt: NEUTRAL_ADDENDUM,
    homeDir: HOME,
  }, "baseline");
  assert.equal(audit.ok, false, "baseline must reject a deferred tool set");
});

test("responses-API payloads pass through with no output cap and a recorded note", (t) => {
  const { observer, readEvents } = makeObserver(t, "E", {});
  const { ctx } = mockCtx();
  const payload = { model: "gpt-5.6-sol", input: [{ role: "user", content: "hi" }], instructions: "x", reasoning: { effort: "high" } };
  const result = observer.handlers.beforeProviderRequest({ payload }, ctx);
  assert.deepEqual(result, payload, "payload must be returned unmodified");
  assert.equal("max_completion_tokens" in (result as any), false);
  assert.equal("max_output_tokens" in (result as any), false);
  const record = readEvents().find((event) => event.type === "provider_request");
  assert.equal(record.output_cap.field, null);
  assert.equal(record.output_cap.note, "responses_api_shape_no_cap_applied");
  assert.equal(observer.state.requests, 1, "still counted as an admitted request");
});

test("completions-API payloads still receive the ceiling", (t) => {
  const { observer, readEvents } = makeObserver(t, "E", {});
  const { ctx } = mockCtx();
  const result = observer.handlers.beforeProviderRequest({ payload: { model: "m", messages: [] } }, ctx) as any;
  assert.equal(result.max_completion_tokens, DEFAULT_LIMITS.maxOutputTokens);
  assert.equal(readEvents().find((event) => event.type === "provider_request").output_cap.field, "max_completion_tokens");
});
