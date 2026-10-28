import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore, type RunState } from "../src/store.ts";
import { createTaskRunLifecycle, PROGRESS_INTERVALS_MS, type ProviderFact } from "../src/task-run-lifecycle.ts";

/** A temp-dir store on a set clock, one session, and a lifecycle over it. No provider, no timers. */
async function harness(t: import("node:test").TestContext) {
  const dir = await mkdtemp(resolve(tmpdir(), "task-lifecycle-"));
  let clock = 1_000_000;
  const store = await new ResearchStore(dir, { now: () => clock }).init();
  await store.registerSession("s1");
  let wakes = 0;
  const logged: string[] = [];
  const lifecycle = createTaskRunLifecycle({ store, sessionId: "s1", onAlerts: () => { wakes++; }, log: message => { logged.push(message); } });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  let calls = 0;
  /** A Task run as submission leaves it: recorded, sent, and (unless `bound` is false) bound to a provider id. */
  async function run(options: { bound?: boolean; state?: "submitting" | "uncertain" } = {}): Promise<string> {
    const begun = await store.beginRun({ sessionId: "s1", intentKey: `call-${++calls}`, intent: { input: "x" }, kind: "task", processor: "core", state: "submitting" });
    if (options.bound !== false) await lifecycle.bound(begun.reference, { providerRunId: `trun_${calls}`, groupId: "tg_1" });
    if (options.state === "uncertain") await store.setRunState({ sessionId: "s1", reference: begun.reference, state: "uncertain", error: "timed out" });
    return begun.reference;
  }
  const state = async (reference: string) => (await store.run("s1", reference))?.state;
  const pending = async () => store.alerts("s1", { states: ["pending"] });
  return { store, lifecycle, run, state, pending, logged, wakes: () => wakes, now: () => clock, advance: (ms: number) => { clock += ms; } };
}

const output = (content: string) => ({ run: { run_id: "trun_1", status: "completed" }, output: { content, basis: [] } }) as unknown as ProviderFact["result"];

test("provider status maps to one local state, whatever the run's state before", async t => {
  // [state before, provider status, state after, still open]
  const table: [RunState | "unbound-submitting", string, RunState, boolean][] = [
    ["submitting", "queued", "accepted", true],
    ["uncertain", "queued", "accepted", true],
    ["uncertain", "running", "pending", true],
    ["accepted", "queued", "accepted", true],
    ["accepted", "running", "pending", true],
    ["accepted", "cancelling", "accepted", true],
    ["accepted", "action_required", "action_required", true],
    ["accepted", "failed", "failed", false],
    ["accepted", "cancelled", "cancelled", false],
    ["accepted", "something_new", "accepted", true],
  ];
  const h = await harness(t);
  for (const [before, status, after, open] of table) {
    const reference = await h.run({ state: before === "uncertain" ? "uncertain" : undefined });
    if (before === "submitting") await h.store.setRunState({ sessionId: "s1", reference, state: "submitting" });
    const result = await h.lifecycle.observed(reference, { status, interactionId: "int_1" });
    assert.equal(await h.state(reference), after, `${before} + ${status}`);
    assert.equal(result.open, open, `${before} + ${status} open`);
  }
  assert.ok(h.logged.some(line => /unknown status something_new/.test(line)), "an unknown status is reported and changes nothing");
});

test("binding confirms an unconfirmed run and keeps the state of a confirmed one", async t => {
  const h = await harness(t);
  const uncertain = await h.run({ bound: false, state: "uncertain" });
  await h.lifecycle.bound(uncertain, { providerRunId: "trun_found", groupId: "tg_1", interactionId: "int_found" });
  const found = await h.store.run("s1", uncertain);
  assert.equal(found?.state, "accepted", "a provider id is proof the run exists");
  assert.equal(found?.provider_interaction_id, "int_found");

  const running = await h.run();
  await h.lifecycle.observed(running, { status: "running" });
  await h.lifecycle.bound(running, { providerRunId: "trun_2" });
  assert.equal(await h.state(running), "pending", "binding again never moves a running run back");
});

test("a terminal run is never moved by a late or replayed fact", async t => {
  const h = await harness(t);
  const reference = await h.run();
  assert.deepEqual(await h.lifecycle.observed(reference, { status: "failed", error: { message: "provider exploded" } }), { open: false });
  for (const status of ["running", "queued", "action_required", "completed", "cancelled"]) {
    assert.deepEqual(await h.lifecycle.observed(reference, { status, result: output("late") }), { open: false });
  }
  await h.lifecycle.bound(reference, { providerRunId: "trun_1", interactionId: "int_late" });
  await h.store.markRunning("s1", reference, 1_000);
  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "failed");
  assert.equal(run?.running_at, undefined, "no timetable starts on a settled run");
  assert.equal((await h.store.alerts("s1")).length, 1, "one failure alert, nothing after it");
});

test("a completed run settles with its report, sources, citations, and one completion alert", async t => {
  const h = await harness(t);
  const reference = await h.run();
  const result = {
    run: { run_id: "trun_1", status: "completed" },
    output: {
      content: "Engine A wins on write throughput.",
      basis: [{ field: "content", reasoning: "measured benchmarks", citations: [{ url: "https://example.org/a", title: "Benchmarks", excerpts: ["A is faster"] }] }],
    },
  } as unknown as ProviderFact["result"];
  assert.deepEqual(await h.lifecycle.observed(reference, { status: "completed", interactionId: "int_1", result }), { open: false });
  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "completed");
  assert.equal(run?.provider_interaction_id, "int_1", "kept for a continuation");
  const hits = (await h.store.search("s1", { reference })).hits;
  assert.deepEqual(hits.map(hit => hit.kind).sort(), ["report", "source"]);
  const report = hits.find(hit => hit.kind === "report")!;
  assert.equal((await h.store.citations("s1", report.handle))[0]?.url, "https://example.org/a");
  const [alert] = await h.pending();
  assert.equal(alert?.kind, "completion");
  assert.match(alert?.headline ?? "", /Research completed: Engine A wins/);
  assert.equal(h.wakes(), 1, "delivery is woken once");
});

test("a completed run without a result stays open, then settles without output after five attempts", async t => {
  const h = await harness(t);
  const reference = await h.run();
  for (let attempt = 1; attempt < 5; attempt++) {
    assert.deepEqual(await h.lifecycle.observed(reference, { status: "completed" }), { open: true }, `attempt ${attempt}`);
    assert.equal(await h.state(reference), "accepted");
  }
  assert.deepEqual(await h.lifecycle.observed(reference, { status: "completed", run: { status: "completed" } }), { open: false });
  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "completed");
  assert.equal(run?.summary, "completed without retrievable output");

  const fetched = await h.run();
  assert.deepEqual(await h.lifecycle.observed(fetched, { status: "completed" }), { open: true });
  assert.deepEqual(await h.lifecycle.observed(fetched, { status: "completed", result: output("The real report.") }), { open: false });
  assert.equal((await h.store.run("s1", fetched))?.summary, "The real report.", "a later fetch that succeeds settles with the output");
});

test("the output in a stored state event settles a run whose result fetch failed", async t => {
  const h = await harness(t);
  const reference = await h.run();
  await h.store.appendObservation({
    sessionId: "s1", reference, source: "run_sse", eventType: "task_run.state", dedupKey: "id:1",
    payload: { type: "task_run.state", output: { content: "From the event.", basis: [] } },
  });
  assert.deepEqual(await h.lifecycle.observed(reference, { status: "completed" }), { open: false });
  assert.equal((await h.store.run("s1", reference))?.summary, "From the event.");
});

test("a failed or cancelled run settles with its reason and a failure alert", async t => {
  const h = await harness(t);
  const failed = await h.run();
  await h.lifecycle.observed(failed, { status: "failed", error: { message: "provider exploded" } });
  const run = await h.store.run("s1", failed);
  assert.equal(run?.state, "failed");
  assert.match(run?.error ?? "", /provider exploded/);
  const cancelled = await h.run();
  await h.lifecycle.observed(cancelled, { status: "cancelled" });
  const alerts = await h.pending();
  assert.deepEqual(alerts.map(alert => alert.kind), ["failure", "failure"]);
  assert.match(alerts.find(alert => alert.reference === failed)!.headline, /Research failed: provider exploded/);
  assert.match(alerts.find(alert => alert.reference === cancelled)!.headline, /cancelled/);
  for (const alert of alerts) assert.match(alert.body ?? "", /web_recall \{ reference/);
});

test("action_required is alerted once per entry, stays watched, pauses the timetable, and can still settle", async t => {
  const h = await harness(t);
  const reference = await h.run();
  await h.lifecycle.observed(reference, { status: "running" });
  assert.deepEqual(await h.lifecycle.observed(reference, { status: "action_required", error: "needs approval" }), { open: true });
  // Collection reads the status again on every reconnect; time passes between reads.
  for (let reread = 0; reread < 3; reread++) {
    h.advance(5_000);
    assert.deepEqual(await h.lifecycle.observed(reference, { status: "action_required" }), { open: true }, "a repeat is still watched");
  }
  let alerts = await h.pending();
  assert.equal(alerts.length, 1, "one alert for one entry");
  assert.equal(alerts[0]!.kind, "action_required");
  assert.match(alerts[0]!.body ?? "", /still watched/);

  h.advance(PROGRESS_INTERVALS_MS.core * 3);
  assert.equal(await h.lifecycle.tick(), 0, "no progress alerts while it waits");

  await h.lifecycle.observed(reference, { status: "running" });
  const resumed = await h.store.run("s1", reference);
  assert.equal(resumed?.state, "pending");
  assert.equal(resumed?.next_alert_at, h.now() + PROGRESS_INTERVALS_MS.core, "the timetable restarts from the resume");

  await h.lifecycle.observed(reference, { status: "action_required" });
  alerts = await h.pending();
  assert.equal(alerts.filter(alert => alert.kind === "action_required").length, 2, "a second halt is a second entry");

  assert.deepEqual(await h.lifecycle.observed(reference, { status: "completed", result: output("Done after all.") }), { open: false });
  assert.equal(await h.state(reference), "completed");
});

test("the progress timetable follows the processor interval and queues one alert per interval", async t => {
  const h = await harness(t);
  const reference = await h.run();
  await h.lifecycle.observed(reference, { status: "running" });
  await h.store.appendObservation({
    sessionId: "s1", reference, source: "run_sse", eventType: "task_run.progress_stats", dedupKey: "stats",
    payload: { source_stats: { num_sources_considered: 7 } },
  });
  const scheduled = await h.store.run("s1", reference);
  assert.equal(scheduled?.alert_interval_ms, PROGRESS_INTERVALS_MS.core, "core: one third of its published upper latency");
  assert.equal(scheduled?.next_alert_at, h.now() + PROGRESS_INTERVALS_MS.core);
  await h.lifecycle.observed(reference, { status: "running" });
  assert.equal((await h.store.run("s1", reference))?.next_alert_at, scheduled?.next_alert_at, "a repeated running event does not push the schedule");

  assert.equal(await h.lifecycle.tick(), 0, "nothing is due yet");
  h.advance(PROGRESS_INTERVALS_MS.core);
  assert.equal(await h.lifecycle.tick(), 1);
  const [alert] = await h.pending();
  assert.equal(alert?.kind, "progress");
  assert.match(alert?.headline ?? "", /still running \(core\): 7 source/);
  assert.equal((await h.store.run("s1", reference))?.next_alert_at, h.now() + PROGRESS_INTERVALS_MS.core, "the alert and the next slot commit together");
  assert.equal(await h.lifecycle.tick(), 0, "the same interval does not alert twice");

  await h.lifecycle.observed(reference, { status: "completed", result: output("Report.") });
  h.advance(PROGRESS_INTERVALS_MS.core * 2);
  assert.equal(await h.lifecycle.tick(), 0, "a settled run has no timetable");
});
