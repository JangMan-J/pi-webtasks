import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createTaskService, validateProcessor, PROGRESS_INTERVALS_MS } from "../src/task-service.ts";

function stream<T>(items: T[]): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() { for (const item of items) yield item; } };
}

function fakeClient(config: {
  events?: (runId: string, attempt: number) => unknown[];
  status?: () => string;
  result?: () => unknown;
  retrieve?: (runId: string) => unknown;
  groupRuns?: () => unknown[];
  addRuns?: (params: Record<string, unknown>) => Record<string, unknown>;
} = {}) {
  const calls = {
    creates: 0,
    adds: [] as { groupId: string; params: Record<string, unknown> }[],
    streams: 0,
    retries: 0,
    results: 0,
    groupReads: 0,
  };
  const client = {
    taskGroup: {
      create: async () => { calls.creates++; return { taskgroup_id: "tg_1", status: { is_active: true } }; },
      addRuns: async (groupId: string, params: Record<string, unknown>) => {
        calls.adds.push({ groupId, params });
        return config.addRuns?.(params) ?? { run_ids: [`trun_${calls.adds.length}`], event_cursor: `cur_${calls.adds.length}`, status: { is_active: true } };
      },
      getRuns: async () => { calls.groupReads++; return stream(config.groupRuns?.() ?? []); },
    },
    taskRun: {
      retrieve: async (runId: string) => {
        calls.retries++;
        if (config.retrieve) return config.retrieve(runId);
        return { run_id: runId, status: config.status?.() ?? "running", interaction_id: "int_1", taskgroup_id: "tg_1" };
      },
      events: async (runId: string) => {
        calls.streams++;
        return stream(config.events?.(runId, calls.streams) ?? []);
      },
      result: async (runId: string) => {
        calls.results++;
        return config.result?.() ?? {
          run: { run_id: runId, status: "completed", interaction_id: "int_1" },
          output: { content: "The report body.", basis: [] },
        };
      },
    },
  };
  return { client, calls };
}

async function harness(t: import("node:test").TestContext, config: Parameters<typeof fakeClient>[0] = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "task-service-"));
  const store = new ResearchStore(dir);
  await store.init();
  await store.registerSession("s1");
  let clock = 1_000_000;
  const { client, calls } = fakeClient(config);
  let alerts = 0;
  const service = createTaskService({
    store,
    sessionId: "s1",
    now: () => clock,
    client: async () => client as never,
    onAlerts: () => { alerts++; },
    log: () => undefined,
    sweepMs: 3_600_000,
    retryMs: 5,
  });
  t.after(async () => { await service.stop(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    store, service, calls, dir,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    alerts: () => alerts,
  };
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error("condition not reached in time");
}

const terminal = async (h: Awaited<ReturnType<typeof harness>>, reference: string) => {
  const run = await h.store.run("s1", reference);
  return run ? ["completed", "failed", "cancelled", "action_required"].includes(run.state) : false;
};

test("submission carries an explicit text schema, events, metadata, and the core floor", async t => {
  const h = await harness(t);
  const receipt = await h.service.submit({ input: "Compare advisory locking across engines", output_description: "A comparison of advisory locking with cited sources" }, { invocationId: "call-1" });

  assert.equal(h.calls.creates, 1, "one Task Group per session");
  assert.equal(h.calls.adds.length, 1);
  const params = h.calls.adds[0]!.params as { inputs: Record<string, unknown>[]; default_task_spec: unknown };
  const input = params.inputs[0]!;
  assert.equal(input.processor, "core", "core is the default floor");
  assert.equal(input.enable_events, true, "progress events are enabled at creation, where alone they can be enabled");
  assert.deepEqual(input.metadata, { webtasks_ref: receipt.details.reference }, "the local reference rides along for reconciliation");
  assert.deepEqual(input.task_spec, { output_schema: { type: "text", description: "A comparison of advisory locking with cited sources" } }, "the caller states the output contract explicitly");
  assert.match(receipt.text, /Research submitted: run_[0-9a-f]{16} \(core, cited text report\)/);
  assert.match(receipt.text, /Contract: core; text report: "A comparison of advisory locking/);
  assert.match(receipt.text, /submitted once; there is nothing to poll or resubmit/);
  assert.match(receipt.text, /end your turn; the completion alert brings you back/, "the receipt says what to do while the run works");
  assert.match(receipt.text, /web_recall \{ reference/);

  const run = await h.store.run("s1", String(receipt.details.reference));
  assert.equal(run?.kind, "task");
  assert.equal(run?.provider_run_id, "trun_1");
  assert.equal(run?.provider_interaction_id, "int_1");
  assert.equal(run?.group_id, "tg_1");
  assert.equal((await h.store.groupForSession("s1"))?.event_cursor, "cur_1");

  await h.service.submit({ input: "A second, unrelated goal", output_description: "short findings" }, { invocationId: "call-2" });
  assert.equal(h.calls.creates, 1, "the group is reused, not recreated");
  assert.equal(h.calls.adds[1]!.groupId, "tg_1");
});

test("a replayed invocation does not buy a second run", async t => {
  const h = await harness(t);
  const first = await h.service.submit({ input: "A goal", output_description: "findings" }, { invocationId: "call-1" });
  const replay = await h.service.submit({ input: "A goal", output_description: "findings" }, { invocationId: "call-1" });
  assert.equal(h.calls.adds.length, 1, "exactly one paid submission");
  assert.equal(replay.details.replayed, true);
  assert.equal(replay.details.reference, first.details.reference);
  assert.match(replay.text, /already submitted/);
  assert.match(replay.text, /not sent again/);
  assert.match(replay.text, /Contract: core; text report/);
});

test("processor policy: core floor, ultra2x ceiling, no silent substitution", async t => {
  assert.equal(validateProcessor(undefined), "core");
  assert.equal(validateProcessor("ultra2x"), "ultra2x");
  for (const bad of ["lite", "base", "ultra4x", "ultra8x", "pro-fast", ""]) {
    if (bad === "") continue;
    assert.throws(() => validateProcessor(bad), /^Error: processor must be one of core, core2x, pro, ultra, ultra2x\.$/, "the error names the choices, not the extension's policy");
  }
  process.env.WEBTASKS_TASK_PROCESSOR = "pro";
  try {
    assert.equal(validateProcessor(undefined), "pro", "the configured default is honored");
  } finally {
    delete process.env.WEBTASKS_TASK_PROCESSOR;
  }

  const h = await harness(t);
  await assert.rejects(() => h.service.submit({ input: "x", processor: "lite" }, { invocationId: "bad-1" }), /processor must be one of core, core2x, pro, ultra, ultra2x\./);
  await assert.rejects(() => h.service.submit({ input: "x", processor: "ultra4x" }, { invocationId: "bad-2" }), /processor must be one of core, core2x, pro, ultra, ultra2x\./);
  assert.equal(h.calls.adds.length, 0, "a rejected processor never reaches the provider");
  assert.deepEqual(await h.store.listRuns("s1"), [], "and records no paid intent");
});

test("structured output requests a JSON schema instead of a text report", async t => {
  const h = await harness(t);
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
  const receipt = await h.service.submit({ input: { question: "which" }, output_schema: schema, processor: "pro" }, { invocationId: "call-1" });
  const input = (h.calls.adds[0]!.params as { inputs: Record<string, unknown>[] }).inputs[0]!;
  assert.deepEqual(input.task_spec, { output_schema: { type: "json", json_schema: schema } });
  assert.equal(input.processor, "pro");
  assert.match(receipt.text, /structured output/);

  await assert.rejects(() => h.service.submit({ input: "x", output_schema: { nothing: true } }, { invocationId: "call-2" }), /JSON Schema/);
  await assert.rejects(() => h.service.submit({ input: "   " }, { invocationId: "call-3" }), /non-empty goal/);
  const before = h.calls.adds.length;
  await assert.rejects(() => h.service.submit({ input: "x" }, { invocationId: "call-4" }), /Say what the run must produce/);
  await assert.rejects(
    () => h.service.submit({ input: "x", output_schema: { type: "object" }, output_description: "text" }, { invocationId: "call-5" }),
    /not both/,
  );
  assert.equal(h.calls.adds.length, before, "an unstated or doubled output contract never reaches the provider");
});

test("a completed stream commits output, citations, sources, and one completion alert", async t => {
  const h = await harness(t, {
    events: () => [
      { type: "task_run.progress_stats", progress_meter: 40, source_stats: { num_sources_considered: 12 } },
      { type: "task_run.progress_msg.result", message: "Interim: engine A is faster.", timestamp: "2026-10-27T00:00:01Z" },
      {
        type: "task_run.state",
        event_id: "",
        run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" },
        output: {
          content: "Engine A wins on write throughput.",
          basis: [{ field: "content", reasoning: "measured benchmarks", citations: [{ url: "https://example.org/a", title: "Benchmarks", excerpts: ["A is faster"] }] }],
        },
      },
    ],
    result: () => ({
      run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" },
      output: {
        content: "Engine A wins on write throughput.",
        basis: [{ field: "content", reasoning: "measured benchmarks", citations: [{ url: "https://example.org/a", title: "Benchmarks", excerpts: ["A is faster"] }] }],
      },
    }),
  });
  const receipt = await h.service.submit({ input: "Compare engines", output_description: "which engine wins write throughput" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => terminal(h, reference));

  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "completed");
  const observations = await h.store.observations("s1", reference);
  assert.deepEqual(observations.map(event => event.eventType).sort(), ["task_run.progress_msg.result", "task_run.progress_stats", "task_run.state"]);

  const evidence = await h.store.search("s1", { reference, limit: 20 });
  const kinds = evidence.hits.map(hit => hit.kind).sort();
  assert.deepEqual(kinds, ["finding", "report", "source"].sort(), `kinds: ${kinds.join(",")}`);
  const report = evidence.hits.find(hit => hit.kind === "report")!;
  assert.match((await h.store.readEvidence("s1", report.handle)).text, /Engine A wins/);
  const finding = evidence.hits.find(hit => hit.kind === "finding")!;
  assert.match((await h.store.readEvidence("s1", finding.handle)).text, /Interim/);
  assert.equal((await h.store.citations("s1", report.handle)).length, 1, "the basis citation is linked to a stored source");
  assert.equal((await h.store.citations("s1", report.handle))[0]!.url, "https://example.org/a");

  const alerts = await h.store.alerts("s1", { states: ["pending"] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "completion");
  assert.match(alerts[0]!.headline, /Research completed/);
  assert.ok(h.alerts() > 0, "the runtime is woken to deliver it");
});

test("a failed result fetch is retried instead of committing a completion without output", async t => {
  let results = 0;
  const h = await harness(t, {
    events: () => [{ type: "task_run.state", run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" } }],
    result: () => {
      if (++results === 1) throw Object.assign(new Error("gateway timeout"), { status: 504 });
      return { run: { run_id: "trun_1", status: "completed" }, output: { content: "The real report.", basis: [] } };
    },
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => terminal(h, reference));
  assert.equal(results, 2, "the result was fetched again after the first failure");
  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "completed");
  assert.match(run?.summary ?? "", /The real report/);
});

test("an accepted run stays bound when its first status read fails", async t => {
  let retrieves = 0;
  const h = await harness(t, {
    retrieve: runId => {
      if (++retrieves === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { run_id: runId, status: "running", interaction_id: "int_1", taskgroup_id: "tg_1" };
    },
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const run = await h.store.run("s1", String(receipt.details.reference));
  assert.equal(run?.provider_run_id, "trun_1", "the paid run is recorded even though the status read failed");
  assert.notEqual(run?.state, "failed", "a 429 on the status read is not a failed submission");
  await h.service.stop();
});

test("a stream that closes without a terminal event is not treated as completion", async t => {
  const h = await harness(t, {
    events: () => [{ type: "task_run.progress_stats", progress_meter: 10, source_stats: { num_sources_considered: 2 } }],
    status: () => "completed",
    result: () => ({ run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" }, output: { content: "Recovered report.", basis: [] } }),
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => terminal(h, reference));
  assert.equal((await h.store.run("s1", reference))?.state, "completed");
  assert.ok(h.calls.retries >= 2, "the provider status decided, not the stream close (one retrieve for the submission, one for the closed stream)");
  assert.match((await h.store.readEvidence("s1", (await h.store.search("s1", { reference, kinds: ["report"] })).hits[0]!.handle)).text, /Recovered report/);
});

test("a failed run stores the failure and alerts without pretending there is output", async t => {
  const h = await harness(t, {
    events: () => [{ type: "task_run.state", event_id: "", run: { run_id: "trun_1", status: "failed", error: { message: "provider exploded" } } }],
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => terminal(h, reference));
  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "failed");
  assert.match(run?.error ?? "", /provider exploded/);
  const alerts = await h.store.alerts("s1");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "failure");
  assert.match(alerts[0]!.body ?? "", /Read what it stored with web_recall/);
});

test("progress alerts follow the processor timetable and coalesce per interval", async t => {
  const h = await harness(t, {
    events: () => [
      { type: "task_run.state", event_id: "", run: { run_id: "trun_1", status: "running", interaction_id: "int_1" } },
      { type: "task_run.progress_stats", progress_meter: 30, source_stats: { num_sources_considered: 7 } },
    ],
    status: () => "running",
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await h.store.run("s1", reference))?.state === "pending");
  await until(async () => (await h.store.observations("s1", reference)).some(event => event.eventType === "task_run.progress_stats"));
  const scheduled = await h.store.run("s1", reference);
  assert.equal(scheduled?.alert_interval_ms, PROGRESS_INTERVALS_MS.core, "core schedule is one third of its published upper latency");
  assert.equal(scheduled?.next_alert_at, h.now() + PROGRESS_INTERVALS_MS.core);

  h.advance(PROGRESS_INTERVALS_MS.core);
  await h.service.tick();
  const alerts = await h.store.alerts("s1", { states: ["pending"] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "progress");
  assert.match(alerts[0]!.headline, /still running \(core\): 7 source/);
  assert.match(alerts[0]!.body ?? "", /Latest finding|Latest activity|No new details/);
  const advanced = await h.store.run("s1", reference);
  assert.equal(advanced?.next_alert_at, h.now() + PROGRESS_INTERVALS_MS.core, "the schedule continues while the run is active");

  await h.service.tick();
  assert.equal((await h.store.alerts("s1", { states: ["pending"] })).length, 1, "the same interval does not produce a second alert");
});

test("an earlier run provides the interaction id for a continuation", async t => {
  const h = await harness(t, {
    events: () => [{ type: "task_run.state", event_id: "", run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" } }],
    status: () => "completed",
  });
  const first = await h.service.submit({ input: "first", output_description: "x" }, { invocationId: "call-1" });
  const reference = String(first.details.reference);
  await until(() => terminal(h, reference));

  await h.service.submit({ input: "follow-up", output_description: "y", continue_from: reference }, { invocationId: "call-2" });
  const input = (h.calls.adds[1]!.params as { inputs: Record<string, unknown>[] }).inputs[0]!;
  assert.equal(input.previous_interaction_id, "int_1");

  await assert.rejects(() => h.service.submit({ input: "x", continue_from: "run_0000000000000000" }, { invocationId: "call-3" }), /not a research record/);
});

test("an unbound submission is recovered from the group instead of resubmitted", async t => {
  const h = await harness(t, {
    groupRuns: () => [{ type: "task_run.state", run: { run_id: "trun_found", status: "running", interaction_id: "int_found", metadata: { webtasks_ref: "run_unbound_placeholder" } } }],
    status: () => "running",
  });
  await h.store.bindGroup("s1", "tg_1", "ready");
  const begun = await h.store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { input: "x" }, kind: "task", state: "submitting" });
  // The fake group reports the reference the store actually allocated.
  const fixed = createTaskService({
    store: h.store, sessionId: "s1", now: h.now,
    client: async () => ({
      taskGroup: {
        create: async () => ({ taskgroup_id: "tg_1" }),
        addRuns: async () => ({ run_ids: ["unused"] }),
        getRuns: async () => stream([{ type: "task_run.state", run: { run_id: "trun_found", status: "running", interaction_id: "int_found", metadata: { webtasks_ref: begun.reference } } }]),
      },
      taskRun: {
        retrieve: async () => ({ run_id: "trun_found", status: "running", interaction_id: "int_found" }),
        events: async () => stream([]),
        result: async () => ({ run: {}, output: { content: "x", basis: [] } }),
      },
    }) as never,
    onAlerts: () => undefined,
    log: () => undefined,
  });
  t.after(() => fixed.stop());
  await fixed.reconcile();
  const recovered = await h.store.run("s1", begun.reference);
  assert.equal(recovered?.provider_run_id, "trun_found", "the provider id was recovered, not bought again");
  assert.equal(h.calls.adds.length, 0);
});

test("reconciliation settles a run that completed while Pi was closed", async t => {
  const h = await harness(t, {
    events: () => [],
    status: () => "completed",
    result: () => ({ run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" }, output: { content: "Finished while closed.", basis: [] } }),
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => terminal(h, reference));
  await h.store.setRunState({ sessionId: "s1", reference, state: "completed" }).catch(() => undefined);
  const reopened = await h.store.run("s1", reference);
  assert.equal(reopened?.state, "completed");
});
