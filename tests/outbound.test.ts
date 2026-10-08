// Outbound completion: the Task Group event stream, snapshot fallback, cursor persistence, and
// owning-session notification. Fake clients are offline; the end-to-end cases run through Pi's loader.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import { WebhookConsumer } from "../src/webhook-consumer.ts";
import { OUTBOUND_BACKOFF, OutboundCollector, outboundEntryId, retryAfterMs } from "../src/outbound.ts";
import { ResearchSession } from "../src/research.ts";
import { setup, type Call } from "./helpers/test-host.ts";

const SESSION = "s-a";
const GROUP = "tg_1";
const ref = (n: string) => `research_00000000-0000-0000-0000-0000000000${n}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sse = (items: unknown[]) => new Response(items.map(i => `event: ${(i as { type: string }).type}\ndata: ${JSON.stringify(i)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

function stream(items: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { for (const item of items) yield item; } };
}
const statusEvent = (eventId: string) => ({
  type: "task_group_status", event_id: eventId,
  status: { is_active: true, num_task_runs: 1, task_run_status_counts: { running: 1 }, status_message: null, modified_at: null },
});
const meta = (reference: string, session = SESSION, group = GROUP) => ({ webtasks_ref: reference, webtasks_session: session, webtasks_group: group });
const run = (runId: string, status: string, metadata: Record<string, string> = {}) => ({
  run_id: runId, interaction_id: `int_${runId}`, status, is_active: ["queued", "running", "cancelling"].includes(status),
  processor: "core", created_at: null, modified_at: null, metadata, taskgroup_id: GROUP,
});
const runEvent = (eventId: string | null, runId: string, status: string, metadata: Record<string, string> = {}) =>
  ({ type: "task_run.state", event_id: eventId, run: run(runId, status, metadata), input: null, output: null });

/** Fake group client. `events` and `snapshot` decide what each call yields; every call is recorded. */
function fakeClient(
  events: (query: { last_event_id?: string }, opts: { signal: AbortSignal }) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
  snapshot: (opts: { signal: AbortSignal }) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> = () => stream([]),
) {
  const calls: { kind: "events" | "snapshot"; last_event_id?: string; signal?: AbortSignal; maxRetries?: number; timeout?: number }[] = [];
  const client = {
    taskGroup: {
      events: async (_group: string, query: { last_event_id?: string }, opts: { signal: AbortSignal; maxRetries?: number; timeout?: number }) => {
        calls.push({ kind: "events", last_event_id: query?.last_event_id, signal: opts?.signal, maxRetries: opts?.maxRetries, timeout: opts?.timeout });
        return events(query ?? {}, opts);
      },
      getRuns: async (_group: string, _query: unknown, opts: { signal: AbortSignal; maxRetries?: number; timeout?: number }) => {
        calls.push({ kind: "snapshot", signal: opts?.signal, maxRetries: opts?.maxRetries, timeout: opts?.timeout });
        return snapshot(opts);
      },
    },
  };
  return { calls, client: client as any };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(10);
  }
  assert.ok(await check(), "condition not met before timeout");
}

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inbox = new WebhookInbox(join(dir, "store"));
  t.after(() => inbox.close());
  await inbox.beginSessionGroup(SESSION);
  await inbox.completeSessionGroup(SESSION, GROUP);
  return { dir, inbox };
}

async function sessionFor(inbox: WebhookInbox, client: any, sessionId = SESSION): Promise<ResearchSession> {
  const session = new ResearchSession({ sessionId, getStore: async () => inbox, getClient: async () => client });
  await session.hydrate();
  return session;
}

/** Local research record bound to a run (accepted) or left uncertain without one. */
async function seed(inbox: WebhookInbox, dir: string, reference: string, runId?: string, sessionId = SESSION) {
  const now = Date.now();
  await inbox.createResearch({ reference, session_id: sessionId, group_id: GROUP, query: "q", effort: "low", status: "dispatching", artifact_dir: join(dir, "results"), created_at: now, updated_at: now });
  if (runId) await inbox.acceptResearch(reference, runId);
  else await inbox.updateResearch(reference, { status: "uncertain", error: "gateway 502" });
}

/** Yields the items, then stalls until aborted. Ends with an error, or quietly, the way an aborted SDK stream can. */
function stalled(items: unknown[], signal: AbortSignal, throwOnAbort: boolean): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
      await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => (throwOnAbort ? reject(new Error("aborted")) : resolve()), { once: true }));
    },
  };
}

/** Replaces a method on a class prototype for one test; restored afterwards. */
function patchMethod(t: { after(fn: () => void): void }, target: object, name: string, replacement: (this: any, original: any, ...args: any[]) => unknown) {
  const proto = target as any;
  const original = proto[name];
  proto[name] = function (this: any, ...args: any[]) { return replacement.call(this, original.bind(this), ...args); };
  t.after(() => { proto[name] = original; });
}

/** Sleeps are recorded, not waited for; a short real yield keeps the loop from starving the test. */
function recordingSleep(sleeps: number[]) {
  return (ms: number, _signal: AbortSignal) => { sleeps.push(ms); return new Promise<void>(resolve => setTimeout(resolve, 2)); };
}

const settledEntry = (runId: string, status: string) => ({
  webhook_id: outboundEntryId(runId, status), resource_id: runId, event_type: "task_run.status",
  event: { type: "task_run.status", source: "outbound", data: { run_id: runId, status } },
});

test("a settled run on the event stream becomes one outbound entry, and the cursor advances with it", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("01"), "run_1");
  const fake = fakeClient(() => stream([statusEvent("e1"), runEvent("e2", "run_1", "completed", meta(ref("01")))]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  await waitFor(async () => (await inbox.listAll()).some(e => e.webhook_id === "outbound:run_1:completed"));
  await collector.stop();
  const entry = (await inbox.listAll()).find(e => e.webhook_id === "outbound:run_1:completed")!;
  assert.equal(entry.resource_id, "run_1");
  assert.equal(entry.kind, "task");
  assert.equal(entry.event_type, "task_run.status");
  assert.deepEqual(entry.event, {
    type: "task_run.status", source: "outbound",
    data: { run_id: "run_1", status: "completed", metadata: meta(ref("01")), interaction_id: "int_run_1" },
  });
  assert.equal((await inbox.getSessionGroup(SESSION))!.event_cursor, "e2", "cursor follows the durable entry");
  assert.equal(fake.calls[0]!.last_event_id, undefined, "a fresh group streams from the live status");
  assert.ok(fake.calls.length > 0 && fake.calls.every(c => c.maxRetries === 0 && c.timeout === 60_000), "no SDK retries; header timeout only");
});

test("reconnect resumes after the stored cursor, and a replayed event adds no second entry", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("02"), "run_2");
  let opened = 0;
  const fake = fakeClient(() => {
    opened++;
    return stream(opened === 1 ? [statusEvent("e1"), runEvent("e2", "run_2", "completed", meta(ref("02")))] : [runEvent("e2", "run_2", "completed", meta(ref("02")))]);
  });
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  await waitFor(() => fake.calls.filter(c => c.kind === "events").length >= 2);
  await collector.stop();
  const opens = fake.calls.filter(c => c.kind === "events");
  assert.equal(opens[0]!.last_event_id, undefined);
  assert.equal(opens[1]!.last_event_id, "e2", "reconnect uses the stored cursor");
  assert.equal((await inbox.listAll()).filter(e => e.webhook_id === "outbound:run_2:completed").length, 1);
});

test("a quiet end-of-stream backs off on a growing, capped schedule instead of spinning", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("03"), "run_3");
  const sleeps: number[] = [];
  const fake = fakeClient(() => stream([]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  await waitFor(() => sleeps.length >= 7);
  await collector.stop();
  // random() = 0 selects the 75% end of each step: base 5 s doubling to the 300 s cap.
  assert.deepEqual(sleeps.slice(0, 7), [3_750, 7_500, 15_000, 30_000, 60_000, 120_000, 225_000]);
  const opens = fake.calls.filter(c => c.kind === "events").length;
  assert.ok(opens <= sleeps.length + 1, `one stream open per backoff step (opened ${opens}, slept ${sleeps.length})`);
});

test("a rate-limited open honors Retry-After, and repeated failures log once", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("04"), "run_4");
  const logs: string[] = [];
  const sleeps: number[] = [];
  const limited = Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after-ms": "600000" }) });
  const fake = fakeClient(() => { throw limited; });
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0, onLog: m => logs.push(m) });
  collector.start();
  await waitFor(() => sleeps.length >= 2);
  await collector.stop();
  assert.deepEqual(sleeps.slice(0, 2), [600_000, 600_000], "the server hint exceeds the computed step");
  assert.equal(logs.length, 1, "one report for a failure streak");
  assert.equal(retryAfterMs(Object.assign(new Error("x"), { status: 429, headers: new Headers({ "retry-after": "7" }) })), 7_000);
  assert.equal(retryAfterMs(Object.assign(new Error("x"), { status: 500, headers: new Headers({ "retry-after-ms": "9" }) })), undefined, "hints apply only to 429 and 503");
});

test("a stream error falls back to the snapshot, which records the settled run", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("05"), "run_5");
  const sleeps: number[] = [];
  const fake = fakeClient(() => { throw new Error("connection reset"); }, () => stream([runEvent(null, "run_5", "completed", meta(ref("05")))]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  await waitFor(async () => (await inbox.listAll()).some(e => e.webhook_id === "outbound:run_5:completed"));
  await collector.stop();
  assert.ok(fake.calls.some(c => c.kind === "snapshot"), "snapshot was the fallback");
  assert.equal((await inbox.getSessionGroup(SESSION))!.event_cursor, undefined, "a snapshot never moves the stream cursor");
});

test("an uncertain submission is bound by metadata, never rebound, and an unmatched one stops driving polls", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("06"));
  await seed(inbox, dir, ref("07"));
  const fake = fakeClient(() => stream([]), () => stream([
    runEvent(null, "run_6", "completed", meta(ref("06"))),
    runEvent(null, "run_7", "running", meta(ref("06"))), // same reference, different run: must not rebind
  ]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  await waitFor(async () => (await inbox.listAll()).some(e => e.webhook_id === "outbound:run_6:completed"));
  await collector.stop();
  const bound = (await inbox.getResearch(ref("06")))!;
  assert.equal(bound.run_id, "run_6");
  assert.equal(await inbox.researchForRun("run_7"), undefined, "a second run never takes an already bound reference");
  assert.equal((await inbox.getResearch(ref("07")))!.status, "uncertain", "no match: stays uncertain, not resubmitted");
  assert.equal((await inbox.getResearch(ref("07")))!.run_id, undefined);
});

test("an unbound uncertain record with no match gets one snapshot pass, then no endless polling", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("08"));
  const fake = fakeClient(() => stream([]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  await waitFor(() => fake.calls.some(c => c.kind === "snapshot"));
  await delay(60);
  await collector.stop();
  assert.equal(fake.calls.filter(c => c.kind === "snapshot").length, 1, "one covering pass");
  assert.equal(fake.calls.filter(c => c.kind === "events").length, 1, "no further stream opens");
});

test("cursor adoption: the first tracked run adopts the addRuns cursor; an existing cursor never moves; an older pending run blocks a jump", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("10"), "run_10");
  assert.equal(await inbox.adoptEventCursor(ref("10"), ""), false, "an empty cursor is not adopted");
  assert.equal(await inbox.adoptEventCursor(ref("10"), "x1"), true, "first tracked run, no stored cursor");
  await seed(inbox, dir, ref("11"), "run_11");
  assert.equal(await inbox.adoptEventCursor(ref("11"), "x2"), false, "an existing cursor is never overwritten");
  assert.equal((await inbox.getSessionGroup(SESSION))!.event_cursor, "x1");

  // A second session with no stored cursor: its first run's addRuns returned no cursor.
  const other = "s-b";
  await inbox.beginSessionGroup(other);
  await inbox.completeSessionGroup(other, "tg_2");
  const now = Date.now();
  for (const [n, runId] of [["20", "run_20"], ["21", "run_21"]] as const) {
    await inbox.createResearch({ reference: ref(n), session_id: other, group_id: "tg_2", query: "q", effort: "low", status: "dispatching", artifact_dir: join(dir, "results"), created_at: now, updated_at: now });
    await inbox.acceptResearch(ref(n), runId);
  }
  assert.equal(await inbox.adoptEventCursor(ref("21"), "y2"), false, "an older pending run blocks adopting a later cursor");
  assert.equal((await inbox.getSessionGroup(other))!.event_cursor, undefined);
});

test("stopping aborts an open stream and settles before the caller closes the store", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("30"), "run_30");
  const fake = fakeClient((_query, opts) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  }));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  await waitFor(() => fake.calls.some(c => c.kind === "events"));
  const outcome = await Promise.race([collector.stop().then(() => "settled"), delay(2000).then(() => "hung")]);
  assert.equal(outcome, "settled");
  assert.equal(fake.calls.find(c => c.kind === "events")!.signal!.aborted, true, "the HTTP stream was aborted");
  await inbox.close();
});

test("a signed callback and the outbound stream for one run: one fetch, one notification", async t => {
  for (const order of ["callback-first", "outbound-first", "cross-process"] as const) {
    const { dir, inbox } = await fixture(t);
    await seed(inbox, dir, ref("40"), "run_40");
    let fetches = 0;
    const client = { taskRun: { result: async () => { fetches++; return { run: { run_id: "run_40", interaction_id: "int_40" }, output: { content: "Cited", basis: [] } }; } } } as any;
    const callback = { webhook_id: "wh-40", resource_id: "run_40", kind: "task" as const, event_type: "task_run.status", event: { type: "task_run.status", data: { run_id: "run_40", status: "completed", metadata: meta(ref("40")) } } };
    const outbound = settledEntry("run_40", "completed");
    const consumer = new WebhookConsumer({ inbox, sessionId: SESSION, getClient: async () => client, artifactDir: join(dir, "results") });
    if (order === "callback-first") {
      await inbox.put(callback);
      await inbox.recordOutbound({ session_id: SESSION, events: [outbound] });
    } else if (order === "outbound-first") {
      await inbox.recordOutbound({ session_id: SESSION, events: [outbound] });
      await inbox.put(callback);
    } else {
      // Two processes each marked their own entry handled before either notified (no ordering guarantee).
      await inbox.put(callback);
      await inbox.recordOutbound({ session_id: SESSION, events: [outbound] });
      for (const id of ["wh-40", outbound.webhook_id]) await inbox.markHandled(id, { resource_id: "run_40", kind: "task", result_artifact: join(dir, "x.json") });
    }
    const { deliveries } = await consumer.recover();
    assert.equal(fetches, order === "cross-process" ? 0 : 1, `${order}: exactly one result fetch`);
    assert.equal(deliveries.length, 1, `${order}: exactly one notification`);
    assert.equal(deliveries[0]!.reference, ref("40"));
    await consumer.acknowledge(deliveries[0]!.webhook_id);
    assert.deepEqual(await inbox.listHandledUnnotified(), [], `${order}: the duplicate is acknowledged too`);
    await inbox.close();
  }
});

test("a connection that makes progress and then stalls ends at its deadline; the next pass resumes from the cursor", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("50"), "run_50");
  const sleeps: number[] = [];
  const fake = fakeClient((_query, opts) => {
    const first = fake.calls.filter(c => c.kind === "events").length === 1;
    return first ? stalled([statusEvent("e1")], opts.signal, true) : stream([]);
  });
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0, deadlines: { connectionMs: 40 } });
  collector.start();
  await waitFor(() => fake.calls.filter(c => c.kind === "events").length >= 2);
  await collector.stop();
  assert.equal(sleeps[0], OUTBOUND_BACKOFF.healthyEofMs, "the cursor advance is progress, so the deadline-ended connection pauses 1 s");
  assert.equal(fake.calls.filter(c => c.kind === "events")[1]!.last_event_id, "e1", "the next pass resumes from the durable cursor");
});

test("a snapshot that stalls past its deadline is a failure with backoff, even when its body ends quietly", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("51"), "run_51");
  const sleeps: number[] = [];
  const logs: string[] = [];
  const fake = fakeClient(() => stream([]), (opts) => stalled([], opts.signal, false));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0, deadlines: { snapshotMs: 40 }, onLog: m => logs.push(m) });
  collector.start();
  await waitFor(() => sleeps.length >= 1);
  await collector.stop();
  assert.equal(sleeps[0], 3_750, "first failure step, not a healthy pause");
  assert.match(logs.join("\n"), /snapshot timed out/);
  assert.ok(fake.calls.find(c => c.kind === "snapshot")!.signal!.aborted, "the snapshot request was aborted at its deadline");
});

test("when the events open and the snapshot both fail, the larger Retry-After hint sets the wait", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("52"), "run_52");
  const sleeps: number[] = [];
  const limited = Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after-ms": "600000" }) });
  const fake = fakeClient(() => { throw limited; }, () => { throw new Error("connection reset"); });
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  await waitFor(() => sleeps.length >= 1);
  await collector.stop();
  assert.equal(sleeps[0], 600_000, "the events hint is not lost when the snapshot also fails");
});

test("a connection that records a new outbound row resets the failure streak to the base step", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("53"), "run_53");
  const sleeps: number[] = [];
  const responses: (() => AsyncIterable<unknown>)[] = [
    () => stream([]),
    () => stream([runEvent("e2", "run_53", "completed", meta(ref("53")))]),
    () => stream([]),
    () => stream([]),
  ];
  const fake = fakeClient(() => (responses.shift() ?? (() => stream([])))());
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  await waitFor(() => sleeps.length >= 4);
  await collector.stop();
  assert.deepEqual(sleeps.slice(0, 4), [3_750, OUTBOUND_BACKOFF.healthyEofMs, 3_750, 7_500]);
});

test("a failed recording transaction rolls back: the cursor does not pass the lost event, and the next pass re-reads it", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("54"), "run_54");
  const fake = fakeClient(() => {
    const first = fake.calls.filter(c => c.kind === "events").length === 1;
    // A value JSON cannot encode makes the recording transaction fail after its insert begins.
    const bad = { ...run("run_54", "completed", meta(ref("54"))), metadata: { ...meta(ref("54")), poison: 10n } };
    return stream(first
      ? [statusEvent("e1"), { type: "task_run.state", event_id: "e2", run: bad }]
      : [runEvent("e2", "run_54", "completed", meta(ref("54")))]);
  });
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  await waitFor(async () => (await inbox.listAll()).some(e => e.webhook_id === "outbound:run_54:completed"));
  await collector.stop();
  const opens = fake.calls.filter(c => c.kind === "events");
  assert.equal(opens[1]!.last_event_id, "e1", "after the failed transaction the cursor stayed at the last durable event");
  assert.equal((await inbox.getSessionGroup(SESSION))!.event_cursor, "e2");
  assert.equal((await inbox.listAll()).filter(e => e.webhook_id === "outbound:run_54:completed").length, 1);
});

test("an uncertain submission whose dispatch is still in flight in this runtime is not bound by a matching snapshot", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("55"), "run_55"); // gives the collector work
  const created = Date.now();
  await inbox.createResearch({ reference: ref("56"), session_id: SESSION, group_id: GROUP, query: "q", effort: "low", status: "dispatching", artifact_dir: join(dir, "results"), created_at: created, updated_at: created });
  const fake = fakeClient(() => stream([]), () => stream([
    runEvent(null, "run_56", "completed", meta(ref("56"))),
    runEvent(null, "run_55", "running", meta(ref("55"))),
  ]));
  // Records created at or after the collector's start belong to this runtime's own dispatches.
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0, startedAt: created });
  collector.start();
  await waitFor(() => fake.calls.some(c => c.kind === "snapshot"));
  await delay(50);
  await collector.stop();
  assert.equal(await inbox.researchForRun("run_56"), undefined, "the in-flight dispatch is not bound by the collector");
  const record = (await inbox.getResearch(ref("56")))!;
  assert.equal(record.status, "dispatching");
  assert.equal(record.run_id, undefined);
  assert.equal((await inbox.listAll()).some(e => e.webhook_id === "outbound:run_56:completed"), false);
});

test("a second entry for an outcome already acknowledged is acknowledged without a second notice, even in a later batch", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("57"), "run_57");
  let fetches = 0;
  const client = { taskRun: { result: async () => { fetches++; return { run: { run_id: "run_57" }, output: { content: "Cited", basis: [] } }; } } } as any;
  const callback = { webhook_id: "wh-57", resource_id: "run_57", kind: "task" as const, event_type: "task_run.status", event: { type: "task_run.status", data: { run_id: "run_57", status: "completed" } } };
  const consumer = new WebhookConsumer({ inbox, sessionId: SESSION, getClient: async () => client, artifactDir: join(dir, "results") });
  await inbox.put(callback);
  const first = await consumer.recover();
  assert.equal(first.deliveries.length, 1);
  await consumer.acknowledge(first.deliveries[0]!.webhook_id);
  // The outbound entry for the same outcome is handled later, by another process, and never announced.
  await inbox.recordOutbound({ session_id: SESSION, events: [settledEntry("run_57", "completed")] });
  await inbox.markHandled(outboundEntryId("run_57", "completed"), { resource_id: "run_57", kind: "task", event_type: "task_run.status", result_artifact: join(dir, "x.json") });
  const later = await consumer.recover();
  assert.equal(later.deliveries.length, 0, "no second notice for the same run and status");
  assert.deepEqual(await inbox.listHandledUnnotified(), [], "the duplicate is acknowledged");
  assert.equal(fetches, 1);
});

test("a stalled events body that makes no progress backs off at its deadline, not a 1 s pause", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("72"), "run_72");
  const sleeps: number[] = [];
  const fake = fakeClient((_query, opts) => stalled([], opts.signal, true));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0, deadlines: { connectionMs: 40 } });
  collector.start();
  await waitFor(() => sleeps.length >= 2);
  await collector.stop();
  assert.deepEqual(sleeps.slice(0, 2), [3_750, 7_500]);
});

test("a reconnect that replays only already-recorded events backs off with an escalating schedule", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("70"), "run_70");
  // Recorded on an earlier connection: the outbound row exists and the stored cursor already sits at its event.
  await inbox.recordOutbound({ session_id: SESSION, events: [settledEntry("run_70", "completed")], cursor: "e2" });
  const sleeps: number[] = [];
  const fake = fakeClient(() => stream([runEvent("e2", "run_70", "completed", meta(ref("70")))]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  await waitFor(() => sleeps.length >= 3);
  await collector.stop();
  assert.deepEqual(sleeps.slice(0, 3), [3_750, 7_500, 15_000], "replays are not progress");
  assert.equal((await inbox.getSessionGroup(SESSION))!.event_cursor, "e2", "the cursor did not move");
  assert.equal((await inbox.listAll()).filter(e => e.webhook_id === "outbound:run_70:completed").length, 1, "no second row");
});

test("a connection that advances the stored cursor resets the backoff to the 1 s pause", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("71"), "run_71");
  await inbox.recordOutbound({ session_id: SESSION, cursor: "e1" });
  const sleeps: number[] = [];
  const responses: (() => AsyncIterable<unknown>)[] = [
    () => stream([]),
    () => stream([statusEvent("e2")]), // a group status advance is progress even without a run row
    () => stream([]),
    () => stream([]),
  ];
  const fake = fakeClient(() => (responses.shift() ?? (() => stream([])))());
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  await waitFor(() => sleeps.length >= 4);
  await collector.stop();
  assert.deepEqual(sleeps.slice(0, 4), [3_750, OUTBOUND_BACKOFF.healthyEofMs, 3_750, 7_500]);
  assert.equal((await inbox.getSessionGroup(SESSION))!.event_cursor, "e2");
});

test("the events request is released after a pass whose snapshot failed, before anything consumes it", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("80"), "run_80");
  const sleeps: number[] = [];
  const fake = fakeClient(() => stream([]), () => { throw new Error("connection reset"); });
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  try {
    await waitFor(() => sleeps.length >= 1);
    // Checked before stop(): this proves the pass itself released the open, unconsumed stream.
    const events = fake.calls.find(c => c.kind === "events")!;
    assert.equal(events.signal!.aborted, true, "the opened events request was released when the pass threw");
  } finally {
    await collector.stop();
  }
});

test("the events request is released after a pass that ends early because the snapshot left no work", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("81"));
  const fake = fakeClient(() => stream([]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep([]), random: () => 0 });
  collector.start();
  try {
    await waitFor(() => fake.calls.some(c => c.kind === "snapshot"));
    await delay(60);
    const events = fake.calls.find(c => c.kind === "events")!;
    assert.equal(events.signal!.aborted, true, "the events request opened for an idle pass was released");
  } finally {
    await collector.stop();
  }
});

test("the snapshot request is released when a snapshot completes", async t => {
  const { dir, inbox } = await fixture(t);
  await seed(inbox, dir, ref("82"), "run_82");
  const sleeps: number[] = [];
  const fake = fakeClient(() => stream([]), () => stream([]));
  const collector = new OutboundCollector({ session: await sessionFor(inbox, fake.client), sleep: recordingSleep(sleeps), random: () => 0 });
  collector.start();
  try {
    await waitFor(() => sleeps.length >= 1);
    const snapshot = fake.calls.find(c => c.kind === "snapshot")!;
    assert.equal(snapshot.signal!.aborted, true, "the snapshot request was released on its exit path");
  } finally {
    await collector.stop();
  }
});

// -------------------------------------------------- end to end through Pi's loader

type TaskGroupState = { script: unknown[]; snapshotStatus: string; submitted: any[]; results: number; lastIds: (string | null)[] };

/** Replays the group's event log after the given cursor, as the service does. */
function replay(script: unknown[], after: string | null): unknown[] {
  const start = after ? script.findIndex(e => (e as { event_id?: string }).event_id === after) + 1 : 0;
  return script.slice(start);
}

function tgHost(tg: TaskGroupState) {
  return async (call: Call) => {
    if (call.path === "/v1/tasks/groups" && call.method === "POST") return json({ taskgroup_id: GROUP, status: { is_active: false } });
    if (call.path === "/v1/tasks/groups/tg_1/runs" && call.method === "POST") {
      tg.submitted.push(call.body.inputs[0]);
      return json({ run_ids: ["run_1"], event_cursor: null, run_cursor: null, status: { is_active: true } });
    }
    if (call.method === "GET" && call.path === "/v1/tasks/groups/tg_1/events") {
      const after = call.query.get("last_event_id");
      tg.lastIds.push(after);
      return sse(replay(tg.script, after));
    }
    if (call.method === "GET" && call.path === "/v1/tasks/groups/tg_1/runs") {
      const metadata = tg.submitted[0]?.metadata;
      return sse(metadata ? [runEvent(null, "run_1", tg.snapshotStatus, metadata)] : []);
    }
    if (call.path === "/v1/tasks/runs/run_1/result") {
      tg.results++;
      return json({ run: { run_id: "run_1", interaction_id: "int_1", status: "completed" }, output: { content: "Finding from the stream", basis: [] } });
    }
    return json({ error: `unexpected ${call.method} ${call.path}` }, 500);
  };
}

test("no callback configured: submit -> stream completion -> saved artifact -> only the owning session is notified", async t => {
  const tg: TaskGroupState = { script: [statusEvent("e1"), runEvent("e2", "run_1", "completed", {})], snapshotStatus: "running", submitted: [], results: 0, lastIds: [] };
  const h = await setup(t, tgHost(tg), {});
  const stranger = await h.instance("session-b"); // a different Pi session, same process
  await h.start();
  await stranger.start();
  const created = await h.call("deep_search", { query: "objective" });
  const reference = created.details.references[0] as string;
  assert.equal("webhook" in tg.submitted[0], false, "no callback field without a configured callback");
  assert.equal(tg.submitted[0].metadata.webtasks_ref, reference);

  await waitFor(() => h.sent.length === 1);
  const message = h.sent[0]!.message as any;
  assert.equal(message.customType, "webtasks-research");
  assert.equal(message.details.reference, reference);
  assert.equal(message.details.status, "completed");
  assert.ok(message.content.includes(reference));
  assert.equal(JSON.parse(await readFile(message.details.artifact, "utf8")).output.content, "Finding from the stream");
  assert.equal(tg.results, 1, "one result fetch");
  assert.equal(stranger.sent.length, 0, "the foreign session is never notified");

  const read = await h.call("deep_search", { research: reference });
  assert.match(read.text, /Finding from the stream/);

  // The store itself, read directly: the run is registered to its owner and nothing is left pending.
  const store = new WebhookInbox(h.inboxDir);
  try {
    assert.equal((await store.listRegistrations()).filter(r => r.session_id === "session-a").length, 1, "the run is registered to its owning session");
    assert.equal((await store.listPending()).length, 0, "nothing is left pending after the notice");
  } finally {
    await store.close();
  }
});

test("closed while running: the completion that arrives during the closed period is delivered on the next start", async t => {
  const tg: TaskGroupState = { script: [statusEvent("e1")], snapshotStatus: "running", submitted: [], results: 0, lastIds: [] };
  const h = await setup(t, tgHost(tg), { sessionId: SESSION });
  await h.start();
  const reference = (await h.call("deep_search", { query: "long task" })).details.references[0] as string;
  await waitFor(() => tg.lastIds.length >= 1);
  await h.stop();
  assert.equal(h.sent.length, 0);

  tg.script.push(runEvent("e2", "run_1", "completed", meta(reference))); // the snapshot still reports it running
  const reloaded = await h.instance(SESSION); // same Pi session ID after a reload
  const mark = tg.lastIds.length;
  await reloaded.start();
  await waitFor(() => reloaded.sent.length === 1);
  assert.equal((reloaded.sent[0]!.message as any).details.reference, reference);
  assert.equal(tg.lastIds[mark], "e1", "the restarted collector resumes from the stored cursor");
  assert.equal(tg.results, 1);
  await reloaded.stop();
});

test("addRuns cursor: the first submission's cursor is adopted for resumption, and a later submission never moves it", async t => {
  const cursors = ["c-first", "c-second"];
  let submitted = 0;
  const h = await setup(t, async (call: Call) => {
    if (call.path === "/v1/tasks/groups" && call.method === "POST") return json({ taskgroup_id: GROUP, status: { is_active: false } });
    if (call.method === "POST" && /\/runs$/.test(call.path)) {
      const n = submitted++;
      return json({ run_ids: [`run_${n + 1}`], event_cursor: cursors[n], run_cursor: `r${n}`, status: { is_active: true } });
    }
    if (call.method === "GET") return sse([]);
    return json({ error: `unexpected ${call.method} ${call.path}` }, 500);
  }, { sessionId: SESSION });
  await h.start();
  await h.call("deep_search", { query: "first" });
  await h.call("deep_search", { query: "second" });
  const probe = new WebhookInbox(h.inboxDir);
  t.after(() => probe.close());
  await waitFor(() => h.calls.some(c => c.method === "GET"));
  assert.equal((await probe.getSessionGroup(SESSION))!.event_cursor, "c-first", "the first run's cursor is adopted; the second never overwrites it");
  const streams = h.calls.filter(c => c.method === "GET" && c.path.endsWith("/events"));
  assert.equal(streams[0]!.query.get("last_event_id"), "c-first", "the collector resumes from the adopted cursor");
});

test("action_required then completion: each outcome is reported once, and completion is collected after the first notice", async t => {
  const tg: TaskGroupState = { script: [statusEvent("e1"), runEvent("e2", "run_1", "action_required", {})], snapshotStatus: "running", submitted: [], results: 0, lastIds: [] };
  const h = await setup(t, tgHost(tg), { sessionId: SESSION });
  await h.start();
  const reference = (await h.call("deep_search", { query: "needs input" })).details.references[0] as string;
  await waitFor(() => h.sent.length === 1);
  assert.match((h.sent[0]!.message as any).content, /needs action/);
  // The run is continued and completes later; only the stored cursor and the watched record can find it.
  tg.script.push(runEvent("e3", "run_1", "completed", meta(reference)));
  await waitFor(() => h.sent.length === 2, 5_000);
  assert.match((h.sent[1]!.message as any).content, /completed/);
  assert.equal(tg.results, 1, "only the completion fetches a result");
  await delay(100);
  assert.equal(h.sent.length, 2, "no further notices for either outcome");
});

test("shutdown during a gated notification lookup sends nothing; the same session's next runtime notifies once", async t => {
  const tg: TaskGroupState = { script: [], snapshotStatus: "completed", submitted: [], results: 0, lastIds: [] };
  // Direct load: the test patches WebhookInbox, which the Pi loader's module instance would not share.
  const h = await setup(t, tgHost(tg), { sessionId: SESSION, direct: true });
  // Seed a settled outcome that is handled but not yet notified, as an earlier process would leave it.
  const inbox = new WebhookInbox(h.inboxDir);
  await inbox.beginSessionGroup(SESSION);
  await inbox.completeSessionGroup(SESSION, GROUP);
  const now = Date.now();
  await inbox.createResearch({ reference: ref("60"), session_id: SESSION, group_id: GROUP, query: "q", effort: "low", status: "dispatching", artifact_dir: join(h.dir, "agent/webtasks/results"), created_at: now, updated_at: now });
  await inbox.acceptResearch(ref("60"), "run_1");
  await inbox.updateResearch(ref("60"), { status: "completed", artifact: join(h.dir, "saved.json") });
  await inbox.recordOutbound({ session_id: SESSION, events: [settledEntry("run_1", "completed")] });
  await inbox.markHandled(outboundEntryId("run_1", "completed"), { resource_id: "run_1", kind: "task", event_type: "task_run.status", result_artifact: join(h.dir, "saved.json") });
  await inbox.close();

  // The lookup is held, then completes while the session is stopping but before the runtime is released.
  // The consumer's stop waits for that completion, which pins the window the guard must cover.
  let gated = true;
  let reached!: () => void;
  const lookup = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let lookupDone!: () => void;
  const finished = new Promise<void>(resolve => { lookupDone = resolve; });
  patchMethod(t, WebhookInbox.prototype, "researchForRun", async function (original, id) {
    if (gated) { reached(); await gate; }
    const out = await original(id);
    lookupDone();
    return out;
  });
  patchMethod(t, WebhookConsumer.prototype, "stop", async function (original) {
    await finished;
    await delay(20); // let the notification path reach its post-lookup check while still stopping
    return original();
  });

  const starting = h.start();
  await lookup;
  const stopping = h.stop();
  gated = false;
  release();
  await stopping;
  await starting;
  assert.equal(h.sent.length, 0, "a stopping runtime never notifies");

  const again = await h.instance(SESSION);
  await again.start();
  await waitFor(() => again.sent.length === 1);
  assert.equal((again.sent[0]!.message as any).details.reference, ref("60"));
  await again.stop();
});
