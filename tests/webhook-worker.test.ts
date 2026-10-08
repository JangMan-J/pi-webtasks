import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Parallel } from "parallel-web";
import { WebhookInbox, DONE_RETENTION_MS } from "../src/webhook-inbox.ts";
import { WebhookConsumer } from "../src/webhook-consumer.ts";
import { WebhookWorker, TASK_META, providerInteractionId, taskIdentity } from "../src/webhook-worker.ts";
import { DEFAULT_WEBHOOK_HOST, WEBHOOK_DIR_ENV, WEBHOOK_PORT_ENV, WEBHOOK_SECRET_ENV, startWebhookReceiver } from "../src/webhook-receiver.ts";
import type { ResearchRecord } from "../src/research-types.ts";

const REAL_FETCH = globalThis.fetch;
const SECRET = "whsec_dGVzdHNlY3JldA==";
const RECEIVER_FILE = fileURLToPath(new URL("../src/webhook-receiver.ts", import.meta.url));

function sign(id: string, ts: string, body: string): string {
  return createHmac("sha256", Buffer.from(SECRET.slice("whsec_".length), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
}
function headers(id: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sign(id, ts, body)}` };
}
async function tmpDir(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "webhook-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
type Call = { path: string };
function mockClient(t: import("node:test").TestContext, handler: (call: Call) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  let clientReads = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
    calls.push({ path: url.pathname });
    const result = handler({ path: url.pathname });
    if (!result) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    clientReads: () => clientReads,
    getClient: async () => {
      clientReads++;
      return new Parallel({ apiKey: "test-key", maxRetries: 0 });
    },
  };
}
function research(dir: string, overrides: Partial<ResearchRecord> = {}): ResearchRecord {
  const now = Date.now();
  return {
    reference: "research_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    session_id: "s-offline",
    group_id: "tg_1",
    query: "explain the result",
    effort: "medium",
    status: "uncertain",
    artifact_dir: join(dir, "owner-results"),
    cwd: dir,
    error: "response lost",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
function taskEvent(runId: string, status: string, meta?: Record<string, string>) {
  return { type: "task_run.status", data: { run_id: runId, status, ...(meta ? { metadata: meta } : {}) } };
}
function meta(record: ResearchRecord): Record<string, string> {
  return { [TASK_META.ref]: record.reference, [TASK_META.session]: record.session_id, [TASK_META.group]: record.group_id };
}
async function deliver(url: string, id: string, event: unknown) {
  const body = JSON.stringify(event);
  const res = await REAL_FETCH(url, { method: "POST", headers: headers(id, body), body });
  assert.equal(res.status, 200);
  return res;
}
async function age(dir: string, webhookId: string, handledAt: number) {
  const db = new DatabaseSync(join(dir, "webhooks.sqlite"));
  db.prepare("UPDATE events SET handled_at = ?, received_at = ? WHERE webhook_id = ?").run(handledAt, handledAt, webhookId);
  db.close();
}

test("a completed result stores only an actual interaction id and does not copy the run or group id", () => {
  assert.equal(providerInteractionId({ run: { run_id: "trun_1", taskgroup_id: "tg_1", status: "completed" }, output: { content: "x" } }), undefined);
  assert.equal(providerInteractionId({ run_id: "trun_1", interaction_id: "int_flat" }), "int_flat");
  assert.equal(providerInteractionId({ run: { run_id: "trun_1", taskgroup_id: "tg_1", interaction_id: "int_9" } }), "int_9");
  assert.equal(providerInteractionId({ previous_interaction_id: "int_prior", run: { run_id: "trun_1" } }), undefined);
});

test("completed retrieval does not invent an interaction id from the run or group", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const record = research(dir, { reference: "research_no_int", status: "pending" });
  await inbox.createResearch(record);
  await inbox.acceptResearch(record.reference, "trun_noid");
  const { calls, getClient } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_noid/result") {
      return { status: 200, body: { run: { run_id: "trun_noid", taskgroup_id: "tg_remote", status: "completed" }, output: { content: "no interaction" } } };
    }
    return undefined;
  });
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await inbox.put({ webhook_id: "wh-noid", event: taskEvent("trun_noid", "completed"), resource_id: "trun_noid", kind: "task" });
  assert.equal((await worker.recover()).processed, 1);
  assert.equal(calls.length, 1);
  const saved = await inbox.getResearch(record.reference);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.run_id, "trun_noid");
  assert.equal(saved?.group_id, record.group_id);
  assert.equal(saved?.interaction_id, undefined);
  assert.ok(saved?.artifact);
});

test("task identity requires webtasks_ref plus session and group, not the overlong reference key", () => {
  const event = taskEvent("trun_1", "completed", { webtasks_ref: "research_1", webtasks_session: "s", webtasks_group: "g" });
  assert.deepEqual(taskIdentity(event, "trun_1"), { reference: "research_1", session: "s", group: "g", run_id: "trun_1" });
  assert.equal(taskIdentity(taskEvent("trun_1", "completed", { webtasks_reference: "research_1", webtasks_session: "s", webtasks_group: "g" }), "trun_1"), undefined);
  assert.equal(taskIdentity(taskEvent("trun_1", "completed", { webtasks_ref: "research_1", webtasks_session: "s" }), "trun_1"), undefined);
  assert.equal(TASK_META.session.length <= 16 && TASK_META.ref.length <= 16 && TASK_META.group.length <= 16, true);
});

test("offline owner: signed callback is saved without Pi, then resume notifies once and does not fetch again", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const receiver = await startWebhookReceiver({ inbox, secret: SECRET, port: 0, host: DEFAULT_WEBHOOK_HOST });
  t.after(() => receiver.close());
  const record = research(dir);
  await inbox.createResearch(record);
  await inbox.acceptResearch(record.reference, "trun_off", "/artifacts/create.json");
  const { calls, getClient, clientReads } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_off/result") return { status: 200, body: { run_id: "trun_off", status: "completed", output: { content: "saved answer" }, run: { run_id: "trun_off", taskgroup_id: "tg_remote", interaction_id: "int_off" } } };
    return undefined;
  });
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  t.after(() => worker.stop());
  await deliver(receiver.url, "wh-off", taskEvent("trun_off", "completed", meta(record)));
  const processed = await worker.recover();
  assert.equal(processed.processed, 1);
  assert.equal(clientReads(), 1);
  assert.equal(calls.length, 1);
  const saved = await inbox.getResearch(record.reference);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.run_id, "trun_off");
  assert.equal(saved?.group_id, "tg_1");
  assert.equal(saved?.interaction_id, "int_off");
  assert.notEqual(saved?.interaction_id, saved?.run_id);
  assert.notEqual(saved?.interaction_id, saved?.group_id);
  assert.ok(saved?.artifact?.startsWith(record.artifact_dir), saved?.artifact);
  assert.equal(JSON.parse(await readFile(saved!.artifact!, "utf8")).output.content, "saved answer");
  assert.equal((await inbox.getRegistration("trun_off"))?.status, "done");
  assert.equal((await inbox.listHandledUnnotified()).length, 1);

  const consumer = new WebhookConsumer({ inbox, sessionId: record.session_id, getClient, artifactDir: join(dir, "fallback") });
  const resumed = await consumer.recover();
  assert.equal(resumed.deliveries.length, 1);
  assert.equal(resumed.deliveries[0]!.reference, record.reference);
  assert.match(resumed.deliveries[0]!.text ?? "", new RegExp(record.reference));
  assert.equal((resumed.deliveries[0]!.text ?? "").includes("trun_off"), false);
  assert.equal(clientReads(), 1, "resume must not fetch again");
  await consumer.acknowledge(resumed.deliveries[0]!.webhook_id);
  assert.equal((await consumer.recover()).deliveries.length, 0);

  await deliver(receiver.url, "wh-off", taskEvent("trun_off", "completed", meta(record)));
  assert.equal((await worker.recover()).processed, 0);
  assert.equal(calls.length, 1, "duplicate webhook-id does not fetch again");
});

test("an unacknowledged notification survives the 72h prune and is delivered on resume", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const record = research(dir, { status: "pending" });
  await inbox.createResearch(record);
  await inbox.acceptResearch(record.reference, "trun_old");
  const { getClient } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_old/result") return { status: 200, body: { run_id: "trun_old", status: "completed", output: { content: "old" } } };
    return undefined;
  });
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await inbox.put({ webhook_id: "wh-old", event: taskEvent("trun_old", "completed"), resource_id: "trun_old", kind: "task" });
  await worker.recover();
  await age(dir, "wh-old", Date.now() - DONE_RETENTION_MS - 60_000);
  assert.equal(await inbox.prune(), 0);
  const consumer = new WebhookConsumer({ inbox, sessionId: record.session_id, getClient, artifactDir: join(dir, "fallback") });
  const resumed = await consumer.recover();
  assert.equal(resumed.deliveries.length, 1);
  assert.equal(resumed.deliveries[0]!.reference, record.reference);
  await consumer.acknowledge("wh-old");
  await age(dir, "wh-old", Date.now() - DONE_RETENTION_MS - 60_000);
  assert.equal(await inbox.prune(), 1);
});

test("a callback older than 30 minutes stays pending until registration, then fetches once", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const { calls, getClient, clientReads } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_late/result") return { status: 200, body: { run_id: "trun_late", status: "completed", output: { content: "late" } } };
    return undefined;
  });
  await inbox.put({ webhook_id: "wh-late", event: taskEvent("trun_late", "completed"), resource_id: "trun_late", kind: "task" });
  await age(dir, "wh-late", Date.now() - 31 * 60 * 1000);
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  assert.equal((await worker.recover()).processed, 0);
  assert.equal(clientReads(), 0);
  assert.equal((await inbox.listPending())[0]!.handled, false);
  await inbox.register({ resource_id: "trun_late", kind: "task", session_id: "s-late", artifact_dir: join(dir, "late-results") });
  assert.equal((await worker.recover()).processed, 1);
  assert.equal(calls.length, 1);
  assert.equal((await inbox.getRegistration("trun_late"))?.status, "done");
  assert.ok((await inbox.getRegistration("trun_late"))?.result_artifact?.startsWith(join(dir, "late-results")));
});

test("uncertain dispatch reconciles only when every metadata field matches the saved record", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const receiver = await startWebhookReceiver({ inbox, secret: SECRET, port: 0, host: DEFAULT_WEBHOOK_HOST });
  t.after(() => receiver.close());
  const record = research(dir);
  await inbox.createResearch(record);
  const { calls, getClient, clientReads } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_match/result") return { status: 200, body: { run_id: "trun_match", status: "completed", output: { content: "matched" } } };
    return undefined;
  });
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await deliver(receiver.url, "wh-mismatch", taskEvent("trun_other", "completed", { ...meta(record), [TASK_META.group]: "tg_other" }));
  await deliver(receiver.url, "wh-old-key", taskEvent("trun_oldkey", "completed", { webtasks_reference: record.reference, webtasks_session: record.session_id, webtasks_group: record.group_id }));
  assert.equal((await worker.recover()).processed, 0);
  assert.equal(clientReads(), 0);
  assert.equal((await inbox.getResearch(record.reference))?.run_id, undefined);
  assert.equal((await inbox.listPending()).length, 2);

  await deliver(receiver.url, "wh-match", taskEvent("trun_match", "completed", meta(record)));
  assert.equal((await worker.recover()).processed, 1);
  assert.deepEqual(calls.map(c => c.path), ["/v1/tasks/runs/trun_match/result"]);
  const saved = await inbox.getResearch(record.reference);
  assert.equal(saved?.run_id, "trun_match");
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.error, undefined, "binding a matched run clears the uncertain error");
  assert.equal((await inbox.getRegistration("trun_match"))?.session_id, record.session_id);
  assert.equal((await inbox.listPending()).length, 2, "non-matching callbacks stay retained");
  await inbox.acceptResearch(record.reference, "trun_match", "/artifacts/http.json");
  assert.equal((await inbox.getResearch(record.reference))?.status, "completed");
  assert.equal((await inbox.getResearch(record.reference))?.creation_artifact, "/artifacts/http.json");
});

test("failure and action_required are recorded without a success fetch", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const failed = research(dir, { reference: "research_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", status: "pending" });
  const action = research(dir, { reference: "research_cccccccc-cccc-cccc-cccc-cccccccccccc", status: "pending" });
  const cancelled = research(dir, { reference: "research_dddddddd-dddd-dddd-dddd-dddddddddddd", status: "pending" });
  await inbox.createResearch(failed);
  await inbox.createResearch(action);
  await inbox.createResearch(cancelled);
  await inbox.acceptResearch(failed.reference, "trun_fail");
  await inbox.acceptResearch(action.reference, "trun_act");
  await inbox.acceptResearch(cancelled.reference, "trun_cancel");
  const { calls, getClient, clientReads } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_act/result") return { status: 200, body: { run_id: "trun_act", status: "completed", output: { content: "continued" } } };
    return undefined;
  });
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await inbox.put({ webhook_id: "wh-fail", event: taskEvent("trun_fail", "failed"), resource_id: "trun_fail", kind: "task", event_type: "task_run.status" });
  await inbox.put({ webhook_id: "wh-fail-dup", event: taskEvent("trun_fail", "failed"), resource_id: "trun_fail", kind: "task" });
  await inbox.put({ webhook_id: "wh-cancel", event: taskEvent("trun_cancel", "cancelled"), resource_id: "trun_cancel", kind: "task" });
  await inbox.put({ webhook_id: "wh-act", event: taskEvent("trun_act", "action_required"), resource_id: "trun_act", kind: "task" });
  assert.equal((await worker.recover()).processed, 4);
  assert.equal(clientReads(), 0);
  assert.equal(calls.length, 0);
  assert.equal((await inbox.getResearch(failed.reference))?.status, "failed");
  assert.equal((await inbox.getRegistration("trun_fail"))?.status, "failed");
  assert.equal((await inbox.getResearch(cancelled.reference))?.status, "cancelled");
  assert.equal((await inbox.getResearch(action.reference))?.status, "action_required");
  assert.equal((await inbox.getRegistration("trun_act"))?.status, "pending", "action required must not retire the run");
  await inbox.put({ webhook_id: "wh-act-done", event: taskEvent("trun_act", "completed"), resource_id: "trun_act", kind: "task" });
  assert.equal((await worker.recover()).processed, 1);
  assert.equal(calls.length, 1, "a later completion after action required still fetches once");
  assert.equal((await inbox.getResearch(action.reference))?.status, "completed");
  const consumer = new WebhookConsumer({ inbox, sessionId: failed.session_id, getClient, artifactDir: join(dir, "fallback") });
  const note = await consumer.recover();
  assert.equal(note.deliveries.length, 4, "the duplicate failure must not notify twice");
  assert.equal(note.deliveries.every(d => !d.text?.includes("trun_")), true);
  assert.match(note.deliveries.find(d => d.reference === cancelled.reference)!.text ?? "", /cancelled/);
  assert.match(note.deliveries.find(d => d.reference === action.reference && d.status === "done")!.text ?? "", /completed/);
});

test("restart reads the saved callback and does not repeat a completed fetch", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  await inbox.register({ resource_id: "trun_restart", kind: "task", session_id: "s-restart", artifact_dir: join(dir, "restart-results") });
  await inbox.put({ webhook_id: "wh-restart", event: taskEvent("trun_restart", "completed"), resource_id: "trun_restart", kind: "task" });
  const { calls, getClient } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_restart/result") return { status: 200, body: { run_id: "trun_restart", status: "completed", output: { content: "after restart" } } };
    return undefined;
  });
  const first = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await first.stop();
  const started = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await started.start();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && calls.length < 1) await delay(20);
  assert.equal(calls.length, 1);
  await started.stop();
  const again = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  await again.start();
  await delay(300);
  assert.equal(calls.length, 1, "restart must not refetch a saved result");
  await again.stop();
  const consumer = new WebhookConsumer({ inbox, sessionId: "s-restart", getClient, artifactDir: join(dir, "fallback") });
  assert.equal((await consumer.recover()).deliveries.length, 1);
});

test("registration after the callback wakes the worker without a manual recover", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  const { calls, getClient } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_watch/result") return { status: 200, body: { run_id: "trun_watch", status: "completed", output: { content: "watched" } } };
    return undefined;
  });
  const worker = new WebhookWorker({ inbox, getClient, artifactDir: join(dir, "fallback") });
  t.after(() => worker.stop());
  await worker.start();
  await inbox.put({ webhook_id: "wh-watch", event: taskEvent("trun_watch", "completed"), resource_id: "trun_watch", kind: "task" });
  await delay(400);
  assert.equal(calls.length, 0, "no registration yet, so no fetch");
  await inbox.register({ resource_id: "trun_watch", kind: "task", session_id: "s-watch" });
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && (await inbox.getRegistration("trun_watch"))?.status !== "done") await delay(25);
  assert.equal(calls.length, 1);
  assert.equal((await inbox.getRegistration("trun_watch"))?.status, "done");
});

test("HTTP ack is not blocked on result retrieval, and getClient is skipped for an unmatched callback", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  let reads = 0;
  const { getClient: realClient } = mockClient(t, call => {
    if (call.path === "/v1/tasks/runs/trun_ack/result") return { status: 200, body: { run_id: "trun_ack", status: "completed", output: { content: "x" } } };
    return undefined;
  });
  const worker = new WebhookWorker({
    inbox,
    getClient: async () => { reads++; await gate; return realClient(); },
    artifactDir: join(dir, "fallback"),
  });
  t.after(() => worker.stop());
  const receiver = await startWebhookReceiver({
    inbox, secret: SECRET, port: 0, host: DEFAULT_WEBHOOK_HOST,
    onAccepted: () => { void worker.recover(); },
  });
  t.after(() => receiver.close());
  const unmatched = JSON.stringify(taskEvent("trun_unmatched", "completed"));
  const early = await REAL_FETCH(receiver.url, { method: "POST", headers: headers("wh-unmatched", unmatched), body: unmatched });
  assert.equal(early.status, 200);
  await delay(50);
  assert.equal(reads, 0, "unmatched callback must not construct a client");

  await inbox.register({ resource_id: "trun_ack", kind: "task", session_id: "s-ack" });
  const body = JSON.stringify(taskEvent("trun_ack", "completed"));
  const acked = await Promise.race([
    REAL_FETCH(receiver.url, { method: "POST", headers: headers("wh-ack", body), body }).then(async res => ({ kind: "http" as const, status: res.status })),
    delay(1000).then(() => ({ kind: "timeout" as const, status: 0 })),
  ]);
  assert.equal(acked.kind, "http");
  assert.equal(acked.status, 200);
  release();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && (await inbox.getRegistration("trun_ack"))?.status !== "done") await delay(20);
  assert.equal((await inbox.getRegistration("trun_ack"))?.status, "done");
});

test("a routable fetch failure is durable and does not crash the receiver when the client cannot be built", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  await inbox.register({ resource_id: "trun_nokey", kind: "task", session_id: "s-nokey" });
  const worker = new WebhookWorker({
    inbox,
    getClient: async () => { throw new Error("Parallel API key missing"); },
    artifactDir: join(dir, "fallback"),
  });
  const receiver = await startWebhookReceiver({
    inbox, secret: SECRET, port: 0, host: DEFAULT_WEBHOOK_HOST,
    onAccepted: () => { void worker.recover(); },
  });
  t.after(async () => { await worker.stop(); await receiver.close(); });
  const body = JSON.stringify(taskEvent("trun_nokey", "completed"));
  const res = await REAL_FETCH(receiver.url, { method: "POST", headers: headers("wh-nokey", body), body });
  assert.equal(res.status, 200);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !(await inbox.listPending())[0]?.fetch_failed) await delay(20);
  const pending = await inbox.listPending();
  assert.equal(pending[0]!.handled, false);
  assert.equal(pending[0]!.fetch_failed, true);
  assert.match(pending[0]!.error ?? "", /API key missing/);
  assert.equal((await inbox.getRegistration("trun_nokey"))?.status, "pending");
});

test("standalone receiver starts without an API key and shuts the in-process worker down", async t => {
  const dir = await tmpDir(t);
  const env = { ...process.env, [WEBHOOK_SECRET_ENV]: SECRET, [WEBHOOK_DIR_ENV]: dir, [WEBHOOK_PORT_ENV]: "0" };
  delete env.PIPARA_API_KEY;
  delete env.PARALLEL_API_KEY;
  const child = spawn(process.execPath, [RECEIVER_FILE], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("CLI did not print a listen URL")), 5000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const line = stdout.split("\n").find(item => item.startsWith("http://"));
      if (line) { clearTimeout(timer); resolveUrl(line); }
    });
    child.on("exit", (code, signal) => {
      if (!stdout.includes("http://")) { clearTimeout(timer); reject(new Error(`CLI exited ${code}/${signal}: ${stderr}`)); }
    });
  });
  const body = JSON.stringify(taskEvent("trun_cli", "completed"));
  const res = await REAL_FETCH(url, { method: "POST", headers: headers("wh-cli", body), body });
  assert.equal(res.status, 200);
  await delay(200);
  assert.equal(child.exitCode, null, "missing API key must not stop the receiver");
  child.kill("SIGTERM");
  const code = await new Promise<number | null>(resolveCode => child.once("close", resolveCode));
  assert.equal(code, 0);
  const inbox = new WebhookInbox(dir);
  t.after(() => inbox.close());
  assert.equal((await inbox.listPending()).length, 1);
});
