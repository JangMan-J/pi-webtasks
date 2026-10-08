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
import { OutboundCollector, outboundEntryId, retryAfterMs } from "../src/outbound.ts";
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
  const calls: { kind: "events" | "snapshot"; last_event_id?: string; signal?: AbortSignal }[] = [];
  const client = {
    taskGroup: {
      events: async (_group: string, query: { last_event_id?: string }, opts: { signal: AbortSignal }) => {
        calls.push({ kind: "events", last_event_id: query?.last_event_id, signal: opts?.signal });
        return events(query ?? {}, opts);
      },
      getRuns: async (_group: string, _query: unknown, opts: { signal: AbortSignal }) => {
        calls.push({ kind: "snapshot", signal: opts?.signal });
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

  const notes: string[] = [];
  await h.commands.get("parallel-webhook").handler("status", { ...h.ctx, ui: { notify: (m: string) => notes.push(m) } });
  assert.match(notes.join("\n"), /1 registrations total \(1 owned by this session\)/, "the command reports the default store, not inactive");
});

test("closed while running: the completion that arrives during the closed period is delivered on the next start", async t => {
  const tg: TaskGroupState = { script: [statusEvent("e1")], snapshotStatus: "running", submitted: [], results: 0, lastIds: [] };
  const h = await setup(t, tgHost(tg), { sessionId: SESSION });
  await h.start();
  const reference = (await h.call("deep_search", { query: "long task" })).details.references[0] as string;
  await waitFor(() => tg.lastIds.length >= 1);
  await h.stop();
  assert.equal(h.sent.length, 0);

  tg.script.push(runEvent("e2", "run_1", "completed", meta(reference)));
  tg.snapshotStatus = "completed";
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
