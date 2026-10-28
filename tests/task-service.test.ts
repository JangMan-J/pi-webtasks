import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore, TERMINAL_RUN_STATES } from "../src/store.ts";
import { createTaskService, validateProcessor } from "../src/task-service.ts";

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
  let clock = 1_000_000;
  const store = new ResearchStore(dir, { now: () => clock });
  await store.init();
  await store.registerSession("s1");
  const { client, calls } = fakeClient(config);
  let alerts = 0;
  const service = createTaskService({
    store,
    sessionId: "s1",
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
  return run ? TERMINAL_RUN_STATES.has(run.state) : false;
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
  assert.match(replay.text, /This research job was already sent as run_/);
  assert.match(replay.text, /not sent again/);
  assert.match(replay.text, /Contract: core; text report/);
});

test("a missing credential fails the submission: nothing was sent, so nothing is being checked", async t => {
  const dir = await mkdtemp(resolve(tmpdir(), "task-service-"));
  const store = await new ResearchStore(dir).init();
  const service = createTaskService({
    store, sessionId: "s1", log: () => undefined, onAlerts: () => undefined,
    client: async () => { throw new Error("Run /login, choose Parallel, and paste an API key"); },
  });
  t.after(async () => { await service.stop(); await store.close(); await rm(dir, { recursive: true, force: true }); });

  await assert.rejects(
    () => service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" }),
    (err: Error) => err.message === "Run /login, choose Parallel, and paste an API key",
  );
  const [run] = await store.listRuns("s1");
  assert.equal(run?.state, "failed", "not uncertain: the provider was never asked");
});

test("a rejected submission is failed; an accepted one that returned no run is uncertain and being checked", async t => {
  const rejected = await harness(t, { addRuns: () => { throw Object.assign(new Error("invalid task spec"), { status: 422 }); } });
  await assert.rejects(
    () => rejected.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" }),
    (err: Error) => /^Research submission did not complete: invalid task spec\. Record run_[0-9a-f]{16}\.$/.test(err.message),
  );
  assert.equal((await rejected.store.listRuns("s1"))[0]?.state, "failed");

  const unbound = await harness(t, { addRuns: () => ({ run_ids: [] }) });
  await assert.rejects(
    () => unbound.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" }),
    (err: Error) => /It may have started anyway: run_[0-9a-f]{16} is being checked/.test(err.message),
  );
  assert.equal((await unbound.store.listRuns("s1"))[0]?.state, "uncertain", "reconciliation looks for it by its reference");
});

test("an accepted run that cannot be recorded is uncertain, whatever the recording error says", async t => {
  const h = await harness(t);
  // A recording failure that happens to carry a 4xx status must not read as a rejection.
  const failing = Object.create(h.store) as ResearchStore;
  failing.bindProviderRun = async () => { throw Object.assign(new Error("constraint failed"), { status: 409 }); };
  const service = createTaskService({
    store: failing, sessionId: "s1", log: () => undefined, onAlerts: () => undefined, retryMs: 5,
    client: async () => ({
      taskGroup: {
        create: async () => ({ taskgroup_id: "tg_1" }),
        addRuns: async () => ({ run_ids: ["trun_1"] }),
      },
    }) as never,
  });
  t.after(() => service.stop());
  await assert.rejects(
    () => service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" }),
    (err: Error) => /recording it failed: constraint failed\. It may have started anyway/.test(err.message) && !/trun_1/.test(err.message),
  );
  assert.equal((await h.store.listRuns("s1"))[0]?.state, "uncertain");
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
  await assert.rejects(
    () => h.service.submit({ input: "x", output_description: "text", exclude_domains: ["https://spam.example"] }, { invocationId: "call-6" }),
    /is not a bare domain/,
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
  let reads = 0;
  const h = await harness(t, {
    events: () => [{ type: "task_run.progress_stats", progress_meter: 10, source_stats: { num_sources_considered: 2 } }],
    // Running at submission; completed by the time the stream has closed.
    status: () => (reads++ === 0 ? "running" : "completed"),
    result: () => ({ run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" }, output: { content: "Recovered report.", basis: [] } }),
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => terminal(h, reference));
  assert.equal((await h.store.run("s1", reference))?.state, "completed");
  assert.ok(h.calls.retries >= 2, "the provider status decided, not the stream close (one retrieve for the submission, one for the closed stream)");
  assert.match((await h.store.readEvidence("s1", (await h.store.search("s1", { reference, kinds: ["report"] })).hits[0]!.handle)).text, /Recovered report/);
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
    store: h.store, sessionId: "s1",
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

test("a run stored as action_required is watched again at session start", async t => {
  const h = await harness(t, { status: () => "running", events: () => [] });
  const begun = await h.store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { input: "x" }, kind: "task", processor: "core", state: "submitting" });
  await h.store.bindProviderRun({ sessionId: "s1", reference: begun.reference, providerRunId: "trun_halted" });
  // A halted run, as an earlier session left it (older releases treated this state as settled).
  await h.store.transitionRun({ sessionId: "s1", reference: begun.reference, from: new Set(["accepted"]), to: "action_required" });

  await h.service.reconcile();
  const resumed = await h.store.run("s1", begun.reference);
  assert.equal(resumed?.state, "pending", "Parallel reports it running again, so it runs locally too");
  assert.ok(h.calls.retries >= 1, "its status was read from Parallel");
  await h.service.stop();
});

test("a replay describes the submission it recorded, with defaults for fields an older row lacks", async t => {
  const h = await harness(t);
  const schema = { type: "object", properties: { verdict: { type: "string" } } };
  await h.service.submit({ input: "x", output_schema: schema, processor: "pro", include_domains: ["docs.example"] }, { invocationId: "call-1" });
  const replay = await h.service.submit({ input: "x", output_description: "other args", processor: "core" }, { invocationId: "call-1" });
  assert.match(replay.text, /Contract: pro; JSON schema output; only docs\.example/, "the recorded request, not the replay's arguments");

  // An older release recorded fewer fields.
  await h.store.beginRun({ sessionId: "s1", intentKey: "call-old", intent: { kind: "task", input: "y" }, kind: "task", state: "submitting" });
  const old = await h.service.submit({ input: "y", output_description: "findings", processor: "core2x" }, { invocationId: "call-old" });
  assert.match(old.text, /This research job was already sent as run_\w+ \(state: submitting\)/);
  assert.match(old.text, /Contract: core2x; text report/);
  assert.equal(h.calls.adds.length, 1, "neither replay was sent");
});

test("a halted run is alerted once however often its stream reconnects", async t => {
  const h = await harness(t, {
    events: () => [{ type: "task_run.state", event_id: "evt_halt", run: { run_id: "trun_1", status: "action_required" } }],
    status: () => "action_required",
  });
  const receipt = await h.service.submit({ input: "goal", output_description: "findings" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => h.calls.streams >= 4);
  h.advance(60_000);
  await until(() => h.calls.streams >= 6);
  await h.service.stop();
  assert.equal((await h.store.run("s1", reference))?.state, "action_required", "still open and watched");
  assert.equal((await h.store.alerts("s1")).filter(alert => alert.kind === "action_required").length, 1);
});
