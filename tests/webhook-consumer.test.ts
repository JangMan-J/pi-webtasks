import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Parallel } from "parallel-web";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import { DEFAULT_WEBHOOK_HOST, startWebhookReceiver } from "../src/webhook-receiver.ts";
import { WebhookConsumer, normalizeEvent, type Delivery } from "../src/webhook-consumer.ts";

// Captured before any test mocks globalThis.fetch, so receiver deliveries in
// this file always use the real loopback HTTP client regardless of which
// mock the Parallel SDK client (used for the *outbound* result/events fetch)
// is currently wearing.
const REAL_FETCH = globalThis.fetch;

const SECRET = "whsec_dGVzdHNlY3JldA==";

function sign(secret: string, id: string, ts: string, body: string): string {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return createHmac("sha256", Buffer.from(raw, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
function headers(id: string, body: string, ts = String(nowSec())) {
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sign(SECRET, id, ts, body)}`,
  };
}

async function tmpDir(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "webhook-consumer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

type Call = { method: string; path: string; query: URLSearchParams };

/** Mocks the Parallel SDK's fetch transport with a call-count ledger, keyed by path. */
function mockClient(t: import("node:test").TestContext, handler: (call: Call) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams };
    calls.push(call);
    const result = handler(call);
    if (!result) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new Parallel({ apiKey: "test-key", maxRetries: 0 });
  return { client, calls };
}

async function setupReceiverAndInbox(t: import("node:test").TestContext) {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const receiver = await startWebhookReceiver({ inbox, secret: SECRET, port: 0, host: DEFAULT_WEBHOOK_HOST });
  t.after(() => receiver.close());
  return { dir, inbox, receiver };
}

async function deliver(receiverUrl: string, id: string, event: unknown) {
  const body = JSON.stringify(event);
  const res = await REAL_FETCH(receiverUrl, { method: "POST", headers: headers(id, body), body });
  return res.status;
}

function consumerFor(inbox: WebhookInbox, sessionId: string, artifactDir: string, getClient: () => Promise<Parallel>) {
  return new WebhookConsumer({ inbox, sessionId, getClient, artifactDir });
}

async function accept(consumer: WebhookConsumer, deliveries: Delivery[]) {
  for (const d of deliveries) await consumer.acknowledge(d.webhook_id);
}

test("normalizeEvent strictly allows documented event types/statuses and nested payloads", () => {
  assert.deepEqual(
    normalizeEvent({ type: "task_run.status", data: { run_id: "trun_1", status: "completed" } }),
    { resource_id: "trun_1", kind: "task", event_type: "task_run.status", action: "fetch" },
  );
  assert.equal(normalizeEvent({ type: "task_run.status", data: { run_id: "trun_1", status: "failed" } }).action, "failure");
  assert.equal(normalizeEvent({ type: "task_run.status", data: { run_id: "trun_1", status: "cancelled" } }).action, "failure");
  assert.equal(normalizeEvent({ type: "task_run.status", data: { run_id: "trun_1", status: "running" } }).action, "unrecognized");
  assert.equal(normalizeEvent({ type: "task_run.status", data: { run_id: "trun_1", status: "queued" } }).action, "unrecognized");
  assert.equal(normalizeEvent({ type: "task_run.status", data: { run_id: "trun_1", status: "cancelling" } }).action, "unrecognized");
  assert.equal(normalizeEvent({ type: "task_run.progress", data: { run_id: "trun_1", status: "completed" } }).action, "unrecognized");
  assert.equal(normalizeEvent({ type: "findall.run.completed", data: { findall_id: "fa_1" } }).action, "fetch");
  assert.equal(normalizeEvent({ type: "findall.run.cancelled", data: { findall_id: "fa_1" } }).action, "failure");
  assert.equal(normalizeEvent({ type: "findall.candidate.matched", data: { findall_id: "fa_1" } }).action, "no_change");
  const detected = normalizeEvent({ type: "monitor.event.detected", data: { monitor_id: "mon_1", event_group_id: "grp_1" } });
  assert.equal(detected.action, "fetch");
  assert.equal(detected.event_group_id, "grp_1");
  const nestedDetected = normalizeEvent({
    type: "monitor.event.detected",
    timestamp: "2025-10-27T14:56:05.619331Z",
    data: { monitor_id: "mon_1", event: { event_group_id: "grp_nested" }, metadata: { team: "research" } },
  });
  assert.equal(nestedDetected.action, "fetch");
  assert.equal(nestedDetected.event_group_id, "grp_nested");
  assert.equal(normalizeEvent({ type: "monitor.execution.completed", data: { monitor_id: "mon_1" } }).action, "no_change");
  assert.equal(normalizeEvent({ type: "monitor.execution.failed", data: { monitor_id: "mon_1" } }).action, "failure");
  assert.equal(normalizeEvent({ type: "monitor.event.detected", data: { monitor_id: "mon_1" } }).action, "unrecognized", "detected without event_group_id must never fetch");
  assert.equal(normalizeEvent({ nonsense: true }).action, "unrecognized");
  assert.equal(normalizeEvent(null).action, "unrecognized");
});

test("task: create -> registration -> signed callback -> exactly one result GET -> owning-session delivery", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_1/result") return { status: 200, body: { run_id: "trun_1", status: "completed", output: { content: "answer" } } };
    return undefined;
  });
  await inbox.register({ resource_id: "trun_1", kind: "task", session_id: "s-owner", creation_artifact: "/artifacts/create.json" });
  const status = await deliver(receiver.url, "wh-1", { type: "task_run.status", data: { run_id: "trun_1", status: "completed" } });
  assert.equal(status, 200);

  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const first = await consumer.recover();
  assert.equal(first.processed, 1);
  assert.equal(first.deliveries.length, 1);
  const stillUnnotified = await inbox.listHandledUnnotified();
  assert.equal(stillUnnotified.length, 1, "ACK happens after successful send, not while collecting");
  const delivery: Delivery = first.deliveries[0]!;
  assert.equal(delivery.kind, "task");
  assert.equal(delivery.status, "done");
  assert.ok(delivery.artifact);
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_1/result").length, 1, "exactly one result GET");
  const saved = JSON.parse(await readFile(delivery.artifact!, "utf8"));
  assert.equal(saved.run_id, "trun_1");
  await accept(consumer, first.deliveries);
  assert.equal((await inbox.listHandledUnnotified()).length, 0);

  // Duplicate delivery of the SAME webhook-id (retry semantics): never re-fetched or re-delivered.
  const dupStatus = await deliver(receiver.url, "wh-1", { type: "task_run.status", data: { run_id: "trun_1", status: "completed" } });
  assert.equal(dupStatus, 200);
  const second = await consumer.recover();
  assert.equal(second.processed, 0);
  assert.equal(second.deliveries.length, 0);
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_1/result").length, 1, "still exactly one result GET after a duplicate delivery");
});

test("findall: completion fetches one snapshot; failure never fetches", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1beta/findall/runs/fa_1/result") return { status: 200, body: { findall_id: "fa_1", run: { findall_id: "fa_1", status: { is_active: false } }, candidates: [] } };
    return undefined;
  });
  await inbox.register({ resource_id: "fa_1", kind: "findall", session_id: "s-owner" });
  await inbox.register({ resource_id: "fa_2", kind: "findall", session_id: "s-owner" });
  await deliver(receiver.url, "wh-fa-done", { type: "findall.run.completed", data: { findall_id: "fa_1" } });
  await deliver(receiver.url, "wh-fa-fail", { type: "findall.run.failed", data: { findall_id: "fa_2", error_message: "quota exceeded" } });

  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const pass = await consumer.recover();
  assert.equal(pass.processed, 2);
  await accept(consumer, pass.deliveries);
  assert.equal(calls.filter(c => c.path === "/v1beta/findall/runs/fa_1/result").length, 1);
  assert.equal(calls.filter(c => c.path.includes("fa_2")).length, 0, "failed run must never trigger a success fetch");

  const byResource = new Map(pass.deliveries.map(d => [d.resource_id, d]));
  assert.equal(byResource.get("fa_1")!.status, "done");
  assert.equal(byResource.get("fa_2")!.status, "failed");
  assert.ok(byResource.get("fa_2")!.error?.includes("quota exceeded"));

  const reg2 = await inbox.getRegistration("fa_2");
  assert.equal(reg2?.status, "failed");
});

test("monitor: multiple distinct detections each fetch once and each deliver independently; execution.completed is silent", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/monitors/mon_1/events") {
      const grp = call.query.get("event_group_id");
      return { status: 200, body: { events: [{ event_group_id: grp, event_type: "event_stream" }] } };
    }
    return undefined;
  });
  await inbox.register({ resource_id: "mon_1", kind: "monitor", session_id: "s-owner" });
  await deliver(receiver.url, "wh-mon-1", { type: "monitor.event.detected", data: { monitor_id: "mon_1", event_group_id: "grp-1" } });
  await deliver(receiver.url, "wh-mon-2", { type: "monitor.event.detected", data: { monitor_id: "mon_1", event_group_id: "grp-2" } });
  await deliver(receiver.url, "wh-mon-nochange", { type: "monitor.execution.completed", data: { monitor_id: "mon_1" } });

  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const pass = await consumer.recover();
  assert.equal(pass.processed, 3);
  assert.equal(pass.deliveries.length, 2, "only the two distinct detections are delivered; no-change execution stays silent");
  assert.deepEqual(pass.deliveries.map(d => d.status).sort(), ["done", "done"]);
  await accept(consumer, pass.deliveries);
  assert.equal(calls.filter(c => c.path === "/v1/monitors/mon_1/events" && c.query.get("event_group_id") === "grp-1").length, 1);
  assert.equal(calls.filter(c => c.path === "/v1/monitors/mon_1/events" && c.query.get("event_group_id") === "grp-2").length, 1);

  // A later, third distinct detection on the SAME monitor_id must still work
  // (registration never gates monitors as "terminal").
  await deliver(receiver.url, "wh-mon-3", { type: "monitor.event.detected", data: { monitor_id: "mon_1", event_group_id: "grp-3" } });
  const third = await consumer.recover();
  assert.equal(third.deliveries.length, 1);
  assert.equal(third.deliveries[0]!.resource_id, "mon_1");
  await accept(consumer, third.deliveries);
});

test("cross-session: foreign consumer does not GET; closed owner remains pending for resume", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_owner/result") return { status: 200, body: { run_id: "trun_owner", status: "completed" } };
    return undefined;
  });
  await inbox.register({ resource_id: "trun_owner", kind: "task", session_id: "s-a" });
  await deliver(receiver.url, "wh-owner", { type: "task_run.status", data: { run_id: "trun_owner", status: "completed" } });

  const artifactDir = await tmpDir(t);
  const otherSession = consumerFor(inbox, "s-b", artifactDir, async () => client);
  const otherPass = await otherSession.recover();
  assert.equal(otherPass.processed, 0, "foreign session must not resolve the owner's entry");
  assert.equal(otherPass.deliveries.length, 0, "must never notify a session that does not own the resource");
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_owner/result").length, 0, "cross-session must not GET");
  assert.equal((await inbox.listPending()).length, 1, "closed owner remains pending");
  assert.equal((await inbox.listPending())[0]!.handled, false);

  const owningSession = consumerFor(inbox, "s-a", artifactDir, async () => client);
  const ownerPass = await owningSession.recover();
  assert.equal(ownerPass.processed, 1);
  assert.equal(ownerPass.deliveries.length, 1, "the owning session's own resume pass must still receive it");
  assert.equal(ownerPass.deliveries[0]!.resource_id, "trun_owner");
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_owner/result").length, 1);
  await accept(owningSession, ownerPass.deliveries);
});

test("invalid signature never reaches the inbox, so the consumer never fetches or delivers anything", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_bad/result") return { status: 200, body: { run_id: "trun_bad", status: "completed" } };
    return undefined;
  });
  await inbox.register({ resource_id: "trun_bad", kind: "task", session_id: "s-owner" });
  const body = JSON.stringify({ type: "task_run.status", data: { run_id: "trun_bad", status: "completed" } });
  const res = await REAL_FETCH(receiver.url, {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": "wh-bad", "webhook-timestamp": String(nowSec()), "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    body,
  });
  assert.equal(res.status, 401);

  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const pass = await consumer.recover();
  assert.equal(pass.processed, 0);
  assert.equal(pass.deliveries.length, 0);
  assert.equal(calls.length, 0, "an unverified delivery must never trigger a result fetch");
});

test("fetch failure is retained for explicit retry: default recover does not GET again; retryFailed gets exactly one GET", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  let fail = true;
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_retry/result") {
      if (fail) return { status: 500, body: { error: "temporary" } };
      return { status: 200, body: { run_id: "trun_retry", status: "completed" } };
    }
    return undefined;
  });
  await inbox.register({ resource_id: "trun_retry", kind: "task", session_id: "s-owner" });
  await deliver(receiver.url, "wh-retry", { type: "task_run.status", data: { run_id: "trun_retry", status: "completed" } });

  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const failedPass = await consumer.recover();
  assert.equal(failedPass.processed, 0, "a failed fetch must not count as processed");
  assert.equal(failedPass.deliveries.length, 0);
  const stillPending = await inbox.listPending();
  assert.equal(stillPending.length, 1, "entry stays pending for retry, not silently dropped");
  assert.equal(stillPending[0]!.fetch_failed, true);
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_retry/result").length, 1);

  fail = false;
  const skipped = await consumer.recover();
  assert.equal(skipped.processed, 0);
  assert.equal(skipped.deliveries.length, 0);
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_retry/result").length, 1, "default recover must not retry a failed fetch");

  const retryPass = await consumer.recover({ retryFailed: true });
  assert.equal(retryPass.processed, 1);
  assert.equal(retryPass.deliveries.length, 1);
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_retry/result").length, 2, "explicit retry is exactly one additional GET; paid creation was never repeated");
  await accept(consumer, retryPass.deliveries);
});

test("failed notification stays recoverable until acknowledge after actual send", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_ack/result") return { status: 200, body: { run_id: "trun_ack", status: "completed" } };
    return undefined;
  });
  await inbox.register({ resource_id: "trun_ack", kind: "task", session_id: "s-owner" });
  await deliver(receiver.url, "wh-ack", { type: "task_run.status", data: { run_id: "trun_ack", status: "completed" } });
  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const first = await consumer.recover();
  assert.equal(first.deliveries.length, 1);
  assert.equal((await inbox.listHandledUnnotified()).map(e => e.webhook_id).join(), "wh-ack");
  const second = await consumer.recover();
  assert.equal(second.deliveries.length, 1, "unacked delivery remains recoverable");
  assert.equal(second.deliveries[0]!.webhook_id, "wh-ack");
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_ack/result").length, 1, "reuse saved result; no second GET");
  await consumer.acknowledge("wh-ack");
  assert.equal((await inbox.listHandledUnnotified()).length, 0);
  const third = await consumer.recover();
  assert.equal(third.deliveries.length, 0);
});

test("unknown task_run type or nonterminal status never fetches or marks the registration terminal", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, () => ({ status: 200, body: { run_id: "trun_live", status: "completed" } }));
  await inbox.register({ resource_id: "trun_live", kind: "task", session_id: "s-owner" });
  await deliver(receiver.url, "wh-running", { type: "task_run.status", data: { run_id: "trun_live", status: "running" } });
  await deliver(receiver.url, "wh-unknown-type", { type: "task_run.progress", data: { run_id: "trun_live", status: "completed" } });
  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const pass = await consumer.recover();
  assert.equal(pass.deliveries.length, 0);
  assert.equal(calls.length, 0);
  const reg = await inbox.getRegistration("trun_live");
  assert.equal(reg?.status, "pending");
});

test("researchOutput without artifact is not marked done/handled; explicit retry can still fetch", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_save/result") return { status: 200, body: { run_id: "trun_save", status: "completed", output: { content: "x" } } };
    return undefined;
  });
  await inbox.register({ resource_id: "trun_save", kind: "task", session_id: "s-owner" });
  await deliver(receiver.url, "wh-save", { type: "task_run.status", data: { run_id: "trun_save", status: "completed" } });
  const blocker = join(await tmpDir(t), "not-a-dir");
  await writeFile(blocker, "x");
  const bad = consumerFor(inbox, "s-owner", join(blocker, "artifacts"), async () => client);
  const failed = await bad.recover();
  assert.equal(failed.processed, 0);
  assert.equal(failed.deliveries.length, 0);
  assert.equal((await inbox.getRegistration("trun_save"))?.status, "pending");
  assert.equal((await inbox.listPending())[0]!.fetch_failed, true);
  assert.equal((await inbox.listPending())[0]!.handled, false);

  const good = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const skipped = await good.recover();
  assert.equal(skipped.processed, 0);
  const retried = await good.recover({ retryFailed: true });
  assert.equal(retried.processed, 1);
  assert.ok(retried.deliveries[0]!.artifact);
  assert.equal((await inbox.getRegistration("trun_save"))?.status, "done");
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_save/result").length, 2);
  await accept(good, retried.deliveries);
});

test("watcher does not retry a failed fetch: ticks stay stable and GET stays at 1", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const { client, calls } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_watch/result") return { status: 500, body: { error: "down" } };
    return undefined;
  });
  await inbox.register({ resource_id: "trun_watch", kind: "task", session_id: "s-owner" });
  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  t.after(() => consumer.stop());
  const ticks: number[] = [];
  consumer.start(() => {
    ticks.push(Date.now());
    void consumer.recover();
  });
  await deliver(receiver.url, "wh-watch", { type: "task_run.status", data: { run_id: "trun_watch", status: "completed" } });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && calls.filter(c => c.path === "/v1/tasks/runs/trun_watch/result").length < 1) {
    await delay(50);
  }
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_watch/result").length, 1, "watcher-driven recover performs the first GET");
  const afterFirst = ticks.length;
  await delay(1150);
  assert.equal(calls.filter(c => c.path === "/v1/tasks/runs/trun_watch/result").length, 1, "failed fetch must not be retried by watcher writes");
  assert.ok(ticks.length - afterFirst <= 2, `watcher ticks after failure must be stable, got ${ticks.length - afterFirst} extra (total ${ticks.length})`);
  const pending = await inbox.listPending();
  assert.equal(pending[0]!.fetch_failed, true);
});

test("stop() aborts an active fetch and waits for the in-flight recover", async t => {
  const { inbox, receiver } = await setupReceiverAndInbox(t);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let sawFetch: () => void;
  const fetchStarted = new Promise<void>(resolve => { sawFetch = resolve; });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sawFetch();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) abort();
      init?.signal?.addEventListener("abort", abort, { once: true });
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new Parallel({ apiKey: "test-key", maxRetries: 0 });
  await inbox.register({ resource_id: "trun_stop", kind: "task", session_id: "s-owner" });
  await deliver(receiver.url, "wh-stop", { type: "task_run.status", data: { run_id: "trun_stop", status: "completed" } });
  const consumer = consumerFor(inbox, "s-owner", await tmpDir(t), async () => client);
  const recoverP = consumer.recover();
  await fetchStarted;
  const stoppedAt = Date.now();
  await consumer.stop();
  const result = await recoverP;
  assert.ok(Date.now() - stoppedAt < 1000, "stop must not wait for the fetch timeout");
  assert.equal(result.processed, 0);
  assert.equal((await inbox.listPending())[0]!.handled, false);
});
