import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { WebhookInbox, DONE_RETENTION_MS } from "../src/webhook-inbox.ts";
import type { ResearchRecord } from "../src/research-types.ts";

const inboxHref = pathToFileURL(fileURLToPath(new URL("../src/webhook-inbox.ts", import.meta.url))).href;

async function tmp(t: import("node:test").TestContext) {
  const dir = await mkdtemp(resolve(tmpdir(), "webhook-inbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Runs `body` (an async arrow function source string referencing `inbox` and
// `process`) in a genuinely separate OS process against the same database
// file. Used to prove cross-process behavior, not just cross-connection
// behavior within one process.
function childScript(dir: string, body: string): string {
  return `
    import(${JSON.stringify(inboxHref)}).then(async ({ WebhookInbox }) => {
      const inbox = new WebhookInbox(${JSON.stringify(dir)});
      ${body}
    }).catch(err => { console.error(err); process.exit(2); });
  `;
}

test("concurrent put() for the same webhook-id accepts exactly once, durably deduped", async t => {
  const dir = await tmp(t);
  const a = new WebhookInbox(dir);
  const b = new WebhookInbox(dir);
  const event = { type: "task_run.status", data: { run_id: "trun_1", status: "completed" } };
  const [r1, r2] = await Promise.all([
    a.put({ webhook_id: "wh-race", event, resource_id: "trun_1", kind: "task", event_type: "task_run.status" }),
    b.put({ webhook_id: "wh-race", event, resource_id: "trun_1", kind: "task", event_type: "task_run.status" }),
  ]);
  const duplicates = [r1, r2].filter(r => r.duplicate).length;
  const accepted = [r1, r2].filter(r => !r.duplicate).length;
  assert.equal(accepted, 1, "exactly one racer must be the accepted writer");
  assert.equal(duplicates, 1, "exactly one racer must observe a duplicate");
  const all = await a.listAll();
  assert.equal(all.length, 1, "no partial/duplicate row was left behind");
  assert.deepEqual(all[0]!.event, event, "durable record holds the true content, not a torn write");
});

test("concurrent register() for the same resource_id never silently overwrites the winner", async t => {
  const dir = await tmp(t);
  const a = new WebhookInbox(dir);
  const b = new WebhookInbox(dir);
  const [regA, regB] = await Promise.all([
    a.register({ resource_id: "trun_2", kind: "task", session_id: "s1", creation_artifact: "/artifacts/from-a.json" }),
    b.register({ resource_id: "trun_2", kind: "task", session_id: "s1", creation_artifact: "/artifacts/from-b.json" }),
  ]);
  assert.equal(regA.creation_artifact, regB.creation_artifact, "both callers must observe the single winning creation_artifact");
  const onDisk = await a.getRegistration("trun_2");
  assert.equal(onDisk?.creation_artifact, regA.creation_artifact, "on-disk record matches what both callers observed");
  assert.ok(["/artifacts/from-a.json", "/artifacts/from-b.json"].includes(onDisk!.creation_artifact!));
});

test("a claim left behind by a crashed (now-dead) process is reclaimed by exactly one caller", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.put({ webhook_id: "wh-crash", event: { type: "task_run.status", data: { run_id: "trun_3" } }, resource_id: "trun_3", kind: "task" });

  // A separate real process claims the entry and exits immediately without
  // releasing or marking it handled: a faithful crash simulation.
  execFileSync(process.execPath, ["--experimental-strip-types", "-e", childScript(dir, `
    const claim = await inbox.claimEntry("wh-crash");
    if (!claim) { console.error("child failed to claim"); process.exit(1); }
    process.exit(0); // crash: no release(), no markHandled()
  `)], { stdio: "inherit" });

  const reclaimed = await inbox.claimEntry("wh-crash");
  assert.ok(reclaimed, "a dead owner's claim must be reclaimable");
  assert.equal(reclaimed!.entry.resource_id, "trun_3");
  await reclaimed!.release();
});

test("two processes racing to reclaim the same dead claim: exactly one wins, never both", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.put({ webhook_id: "wh-race-reclaim", event: { type: "task_run.status" }, resource_id: "trun_race", kind: "task" });
  execFileSync(process.execPath, ["--experimental-strip-types", "-e", childScript(dir, `
    const claim = await inbox.claimEntry("wh-race-reclaim");
    if (!claim) process.exit(1);
    process.exit(0); // dies holding the claim
  `)], { stdio: "inherit" });

  // A winner that exits immediately looks identical to "crashed" to the other
  // racer, which would let a second attempt legitimately re-claim a since-
  // abandoned slot rather than actually contend for the same live claim. Hold
  // the process alive briefly after deciding so a concurrent racer's read
  // observes a genuinely live owner, not a second stale one.
  const resultsPromise = new Promise<string[]>((resolvePromise) => {
    const outputs: string[] = [];
    let remaining = 2;
    const done = () => { if (--remaining === 0) resolvePromise(outputs); };
    for (let i = 0; i < 2; i++) {
      execFile(process.execPath, ["--experimental-strip-types", "-e", childScript(dir, `
        const claim = await inbox.claimEntry("wh-race-reclaim");
        console.log(claim ? "won" : "lost");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        process.exit(0);
      `)], (_err, stdout) => {
        outputs.push(stdout.trim());
        done();
      });
    }
  });
  const results = await resultsPromise;
  assert.deepEqual(results.filter(r => r === "won").length, 1, `exactly one reclaimer must win; got ${JSON.stringify(results)}`);
  assert.deepEqual(results.filter(r => r === "lost").length, 1, `exactly one reclaimer must lose; got ${JSON.stringify(results)}`);
});

test("a claim held by a live process is never reclaimed, even immediately", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.put({ webhook_id: "wh-live", event: { type: "task_run.status" }, resource_id: "trun_4", kind: "task" });
  const held = await inbox.claimEntry("wh-live"); // current test process: unambiguously alive
  assert.ok(held);
  const second = await inbox.claimEntry("wh-live");
  assert.equal(second, undefined, "must not steal a live owner's claim");
  await held!.release();
  const third = await inbox.claimEntry("wh-live");
  assert.ok(third, "released claim becomes available again");
  await third!.release();
});

test("monitor registrations never gate a second, distinct detected event", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.register({ resource_id: "monitor_1", kind: "monitor", session_id: "s1" });

  await inbox.put({ webhook_id: "wh-evt-1", event: { data: { event: { event_group_id: "grp-1" } } }, resource_id: "monitor_1", kind: "monitor", event_type: "monitor.event.detected" });
  const claim1 = await inbox.claimEntry("wh-evt-1");
  assert.ok(claim1);
  assert.equal(await inbox.isTerminal("monitor_1"), false, "monitor must never report terminal status");
  await inbox.markHandled("wh-evt-1", { result_artifact: "/artifacts/grp-1.json" });
  await claim1!.release();

  // Second, independent detected event on the SAME monitor_id: a resource-
  // level "done" gate would wrongly suppress this. It must not.
  await inbox.put({ webhook_id: "wh-evt-2", event: { data: { event: { event_group_id: "grp-2" } } }, resource_id: "monitor_1", kind: "monitor", event_type: "monitor.event.detected" });
  assert.equal(await inbox.isTerminal("monitor_1"), false);
  const claim2 = await inbox.claimEntry("wh-evt-2");
  assert.ok(claim2, "second distinct event_group_id must still be claimable and processed");
  await inbox.markHandled("wh-evt-2", { result_artifact: "/artifacts/grp-2.json" });
  await claim2!.release();

  const handled = (await inbox.listAll()).filter(e => e.handled);
  assert.equal(handled.length, 2);
  assert.deepEqual(handled.map(e => e.result_artifact).sort(), ["/artifacts/grp-1.json", "/artifacts/grp-2.json"]);
});

test("put() ACK is durable and visible to a fresh connection immediately (simulated restart)", async t => {
  const dir = await tmp(t);
  const a = new WebhookInbox(dir);
  const result = await a.put({ webhook_id: "wh-durable", event: { ok: true }, resource_id: "trun_5", kind: "task" });
  assert.equal(result.duplicate, false);
  await a.close();
  const b = new WebhookInbox(dir); // fresh connection, simulating a process restart
  const pending = await b.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.webhook_id, "wh-durable");
});

test("completion arriving before registration is retried, not lost or blindly fetched", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.put({ webhook_id: "wh-early", event: { type: "task_run.status", data: { run_id: "trun_6", status: "completed" } }, resource_id: "trun_6", kind: "task" });
  assert.equal(await inbox.getRegistration("trun_6"), undefined, "no registration exists yet");
  let pending = await inbox.listPending();
  assert.equal(pending.length, 1, "event stays durably pending, not discarded");
  assert.equal(pending[0]!.handled, false);
  assert.equal(inbox.isOrphanExpired(pending[0]!), false, "still within the local grace window");
  await inbox.register({ resource_id: "trun_6", kind: "task", session_id: "s1" });
  pending = await inbox.listPending();
  assert.equal(pending.length, 1, "now fetchable on the next sweep, without re-delivery");
});

test("prune removes only acknowledged handled records and never unacknowledged notifications or pending callbacks", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.put({ webhook_id: "wh-old-acked", event: {}, resource_id: "trun_7", kind: "task" });
  await inbox.markHandled("wh-old-acked", {});
  await inbox.markNotified("wh-old-acked");
  await inbox.put({ webhook_id: "wh-old-unacked", event: {}, resource_id: "trun_7b", kind: "task" });
  await inbox.markHandled("wh-old-unacked", { result_artifact: "/artifacts/kept.json" });
  await inbox.put({ webhook_id: "wh-fresh-pending", event: {}, resource_id: "trun_8", kind: "task" });
  const removed = await inbox.prune(-1); // every acknowledged handled row looks expired
  assert.equal(removed, 1);
  const remaining = await inbox.listAll();
  assert.deepEqual(remaining.map(e => e.webhook_id).sort(), ["wh-fresh-pending", "wh-old-unacked"]);
  assert.equal(remaining.find(e => e.webhook_id === "wh-old-unacked")!.notified, false);
});

test("register() rejects a genuinely conflicting kind or session, rather than silently reassigning ownership", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.register({ resource_id: "trun_conflict", kind: "task", session_id: "s1", creation_artifact: "/artifacts/s1.json" });

  // Same resource_id, different owning session: must not silently switch ownership.
  await assert.rejects(
    () => inbox.register({ resource_id: "trun_conflict", kind: "task", session_id: "s2", creation_artifact: "/artifacts/s2.json" }),
    /already registered as task\/s1/,
  );
  // Same resource_id, different kind: must not silently reclassify the resource.
  await assert.rejects(
    () => inbox.register({ resource_id: "trun_conflict", kind: "findall", session_id: "s1" }),
    /already registered as task\/s1/,
  );
  // The original registration is untouched by either rejected attempt.
  const reg = await inbox.getRegistration("trun_conflict");
  assert.equal(reg?.kind, "task");
  assert.equal(reg?.session_id, "s1");
  assert.equal(reg?.creation_artifact, "/artifacts/s1.json");
});

test("markHandled persists consumer-derived resource_id/kind/event_type without overwriting on a later no-op patch", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  // Simulate the shared receiver's contract: put() with no routing fields.
  await inbox.put({ webhook_id: "wh-normalize", event: { type: "task_run.status", data: { run_id: "trun_9", status: "completed" } } });
  let row = (await inbox.listAll())[0]!;
  assert.equal(row.resource_id, undefined);
  const claim = await inbox.claimEntry("wh-normalize");
  assert.ok(claim);
  await inbox.markHandled("wh-normalize", { resource_id: "trun_9", kind: "task", event_type: "task_run.status", result_artifact: "/artifacts/trun_9.json" });
  await claim!.release();
  row = (await inbox.listAll())[0]!;
  assert.equal(row.resource_id, "trun_9");
  assert.equal(row.kind, "task");
  assert.equal(row.event_type, "task_run.status");
  assert.equal(row.notified, false, "handled and notified are independent");
});

test("listHandledUnnotified / markNotified track per-entry delivery independent of resource-level status", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.register({ resource_id: "monitor_9", kind: "monitor", session_id: "s1" });
  await inbox.put({ webhook_id: "wh-notify-1", event: {}, resource_id: "monitor_9", kind: "monitor" });
  await inbox.put({ webhook_id: "wh-notify-2", event: {}, resource_id: "monitor_9", kind: "monitor" });
  for (const id of ["wh-notify-1", "wh-notify-2"]) {
    const claim = await inbox.claimEntry(id);
    await inbox.markHandled(id, { result_artifact: `/artifacts/${id}.json` });
    await claim!.release();
  }
  let unnotified = await inbox.listHandledUnnotified();
  assert.equal(unnotified.length, 2, "both distinct detections await delivery independently");
  await inbox.markNotified("wh-notify-1");
  unnotified = await inbox.listHandledUnnotified();
  assert.deepEqual(unnotified.map(e => e.webhook_id), ["wh-notify-2"], "delivering one detection must not suppress the other");
});

test("recordFetchFailure persists across a new connection and does not mark handled", async t => {
  const dir = await tmp(t);
  const a = new WebhookInbox(dir);
  await a.put({ webhook_id: "wh-fetch-fail", event: { type: "task_run.status", data: { run_id: "trun_ff", status: "completed" } }, resource_id: "trun_ff", kind: "task" });
  await a.recordFetchFailure("wh-fetch-fail", "GET 500");
  const pending = await a.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.handled, false);
  assert.equal(pending[0]!.fetch_failed, true);
  assert.equal(pending[0]!.error, "GET 500");
  await a.close();
  const b = new WebhookInbox(dir);
  const again = await b.listPending();
  assert.equal(again[0]!.fetch_failed, true);
  assert.equal(again[0]!.handled, false);
  await b.markHandled("wh-fetch-fail", { result_artifact: "/artifacts/ok.json" });
  const done = (await b.listAll())[0]!;
  assert.equal(done.handled, true);
  assert.equal(done.fetch_failed, false, "markHandled clears fetch_failed");
});

function research(overrides: Partial<ResearchRecord> = {}): ResearchRecord {
  const now = Date.now();
  return {
    reference: "research_11111111-1111-1111-1111-111111111111",
    session_id: "s1",
    group_id: "tg_1",
    query: "what happened",
    effort: "low",
    status: "dispatching",
    artifact_dir: "/owner/results",
    cwd: "/work",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test("getSessionGroup is lookup-only; beginSessionGroup inserts once and does not reset initializing or uncertain", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  assert.equal(await inbox.getSessionGroup("s1"), undefined);
  const first = await inbox.beginSessionGroup("s1");
  assert.equal(first.created, true);
  assert.equal(first.record.status, "initializing");
  assert.equal(first.record.owner_pid, process.pid);
  assert.equal(first.record.group_id, undefined);
  const again = await inbox.beginSessionGroup("s1");
  assert.equal(again.created, false, "an initializing row must not start a second create");
  assert.equal(again.record.status, "initializing");
  assert.equal(again.record.owner_pid, first.record.owner_pid);
  assert.equal(await inbox.getSessionGroup("s2"), undefined, "lookup of another session still inserts nothing");

  await inbox.failSessionGroup("s1", "setup failed");
  const afterFail = await inbox.beginSessionGroup("s1");
  assert.equal(afterFail.created, false, "uncertain state must not start a second create");
  assert.equal(afterFail.record.status, "uncertain");
  assert.match(afterFail.record.error ?? "", /setup failed/);
  await inbox.completeSessionGroup("s1", "tg_saved");
  const ready = await inbox.getSessionGroup("s1");
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.group_id, "tg_saved");
  assert.equal(ready?.error, undefined);
  const reused = await inbox.beginSessionGroup("s1");
  assert.equal(reused.created, false);
  assert.equal(reused.record.group_id, "tg_saved");
  await assert.rejects(() => inbox.completeSessionGroup("s1", "tg_other"), /already bound to tg_saved/);
  assert.equal((await inbox.getSessionGroup("s1"))?.group_id, "tg_saved");
});

test("concurrent beginSessionGroup creates one row", async t => {
  const dir = await tmp(t);
  const a = new WebhookInbox(dir);
  const b = new WebhookInbox(dir);
  const [left, right] = await Promise.all([a.beginSessionGroup("s-race"), b.beginSessionGroup("s-race")]);
  assert.equal([left.created, right.created].filter(Boolean).length, 1);
  assert.equal(left.record.session_id, right.record.session_id);
  assert.equal(left.record.status, "initializing");
});

test("acceptResearch binds identity, registers the owner namespace, and preserves a terminal callback", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.createResearch(research());
  await inbox.acceptResearch(research().reference, "trun_bound", "/artifacts/create.json");
  const bound = await inbox.getResearch(research().reference);
  assert.equal(bound?.status, "pending");
  assert.equal(bound?.run_id, "trun_bound");
  assert.equal(bound?.error, undefined);
  assert.equal(bound?.creation_artifact, "/artifacts/create.json");
  const reg = await inbox.getRegistration("trun_bound");
  assert.equal(reg?.kind, "task");
  assert.equal(reg?.session_id, "s1");
  assert.equal(reg?.artifact_dir, "/owner/results");
  assert.equal(reg?.cwd, "/work");
  assert.equal(reg?.status, "pending");
  assert.equal((await inbox.researchForRun("trun_bound"))?.reference, research().reference);

  await inbox.updateResearch(research().reference, { status: "completed", artifact: "/owner/results/done.json" });
  await inbox.updateRegistration("trun_bound", { status: "done", result_artifact: "/owner/results/done.json" });
  await inbox.acceptResearch(research().reference, "trun_bound", "/artifacts/later.json");
  const kept = await inbox.getResearch(research().reference);
  assert.equal(kept?.status, "completed", "a later accept must not downgrade a callback that already finished");
  assert.equal(kept?.artifact, "/owner/results/done.json");
  assert.equal(kept?.creation_artifact, "/artifacts/create.json", "creation artifact is set once");
  assert.equal((await inbox.getRegistration("trun_bound"))?.status, "done");
  await assert.rejects(() => inbox.acceptResearch(research().reference, "trun_other"), /already bound to trun_bound/);
  assert.equal((await inbox.getResearch(research().reference))?.run_id, "trun_bound");
});

test("updateResearch rejects identity reassignment and terminal downgrade", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.createResearch(research({ status: "uncertain", error: "lost response" }));
  await inbox.updateResearch(research().reference, { status: "uncertain", error: "still lost", updated_at: 50 });
  assert.equal((await inbox.getResearch(research().reference))?.updated_at, 50);
  await assert.rejects(() => inbox.updateResearch(research().reference, { session_id: "s2" }), /cannot be reassigned/);
  await assert.rejects(() => inbox.updateResearch(research().reference, { run_id: "trun_x" }), /acceptResearch/);
  await inbox.updateResearch(research().reference, { status: "completed", artifact: "/a.json" });
  await assert.rejects(() => inbox.updateResearch(research().reference, { status: "pending" }), /refusing to change/);
  assert.equal((await inbox.getResearch(research().reference))?.status, "completed");
  await assert.rejects(() => inbox.createResearch(research()), /already exists/);
});

test("saveConversation is an immutable insert", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.saveConversation({ reference: "conversation_1", session_id: "s1", status: "completed", response_id: "resp_1", created_at: 10 });
  assert.equal((await inbox.getConversation("conversation_1"))?.response_id, "resp_1");
  await assert.rejects(() => inbox.saveConversation({
    reference: "conversation_1", session_id: "s1", status: "uncertain", created_at: 11,
  }), /already exists/);
  assert.equal((await inbox.getConversation("conversation_1"))?.status, "completed");
  assert.equal(await inbox.getConversation("missing"), undefined);
});

test("migration keeps legacy events and registrations and adds owner artifact columns", async t => {
  const dir = await tmp(t);
  const db = new DatabaseSync(join(dir, "webhooks.sqlite"));
  db.exec(`CREATE TABLE events (
    webhook_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, event_json TEXT NOT NULL,
    resource_id TEXT, kind TEXT, event_type TEXT, handled INTEGER NOT NULL DEFAULT 0,
    handled_at INTEGER, result_artifact TEXT, error TEXT, terminal_failure INTEGER NOT NULL DEFAULT 0,
    claimed_by INTEGER, claimed_at INTEGER, notified INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE registrations (
    resource_id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, webhook_url TEXT,
    registered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL,
    creation_artifact TEXT, result_artifact TEXT, error TEXT, delivered INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare("INSERT INTO events (webhook_id, received_at, event_json, resource_id, kind, handled, notified) VALUES (?, ?, ?, ?, ?, 1, 0)").run(
    "wh-legacy", 1, JSON.stringify({ type: "task_run.status", data: { run_id: "trun_legacy" } }), "trun_legacy", "task",
  );
  db.prepare("INSERT INTO registrations (resource_id, kind, session_id, registered_at, updated_at, status, delivered) VALUES (?, 'task', 's-old', 1, 1, 'pending', 0)").run("trun_legacy");
  db.close();

  const inbox = new WebhookInbox(dir);
  const events = await inbox.listAll();
  assert.equal(events[0]!.webhook_id, "wh-legacy");
  assert.equal(events[0]!.notified, false);
  const reg = await inbox.getRegistration("trun_legacy");
  assert.equal(reg?.session_id, "s-old");
  assert.equal(reg?.artifact_dir, undefined);
  await inbox.markNotified("wh-legacy");
  const aged = new DatabaseSync(join(dir, "webhooks.sqlite"));
  aged.prepare("UPDATE events SET handled_at = ? WHERE webhook_id = ?").run(Date.now() - DONE_RETENTION_MS - 1_000, "wh-legacy");
  aged.close();
  assert.equal(await inbox.prune(), 1, "acknowledged legacy events past retention can still be pruned");
  await inbox.put({ webhook_id: "wh-keep", event: { type: "task_run.status" }, resource_id: "trun_keep", kind: "task" });
  await inbox.markHandled("wh-keep", {});
  const keep = new DatabaseSync(join(dir, "webhooks.sqlite"));
  keep.prepare("UPDATE events SET handled_at = ? WHERE webhook_id = ?").run(Date.now() - DONE_RETENTION_MS - 5_000, "wh-keep");
  keep.close();
  assert.equal(await inbox.prune(), 0);
  assert.equal((await inbox.listAll())[0]!.webhook_id, "wh-keep");
});

test("current research rows gain interaction and parent columns without losing legacy events", async t => {
  const dir = await tmp(t);
  const db = new DatabaseSync(join(dir, "webhooks.sqlite"));
  db.exec(`CREATE TABLE events (
    webhook_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, event_json TEXT NOT NULL,
    resource_id TEXT, kind TEXT, event_type TEXT, handled INTEGER NOT NULL DEFAULT 0,
    handled_at INTEGER, result_artifact TEXT, error TEXT, terminal_failure INTEGER NOT NULL DEFAULT 0,
    claimed_by INTEGER, claimed_at INTEGER, notified INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE research (
    reference TEXT PRIMARY KEY, session_id TEXT NOT NULL, group_id TEXT NOT NULL, run_id TEXT,
    query TEXT NOT NULL, effort TEXT NOT NULL, domains_json TEXT, status TEXT NOT NULL,
    artifact_dir TEXT NOT NULL, cwd TEXT, artifact TEXT, creation_artifact TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.prepare("INSERT INTO events (webhook_id, received_at, event_json, handled, notified) VALUES ('wh-old', 1, '{}', 0, 0)").run();
  db.prepare("INSERT INTO research (reference, session_id, group_id, run_id, query, effort, status, artifact_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)").run(
    "research_old", "s-old", "tg_old", "trun_old", "prior question", "low", "pending", "/old/results",
  );
  db.close();
  const inbox = new WebhookInbox(dir);
  assert.equal((await inbox.listPending())[0]!.webhook_id, "wh-old");
  const row = await inbox.getResearch("research_old");
  assert.equal(row?.run_id, "trun_old");
  assert.equal(row?.group_id, "tg_old");
  assert.equal(row?.interaction_id, undefined);
  assert.equal(row?.parent, undefined);
  await inbox.updateResearch("research_old", { interaction_id: "int_learned" });
  assert.equal((await inbox.getResearch("research_old"))?.interaction_id, "int_learned");
  assert.equal((await inbox.getResearch("research_old"))?.run_id, "trun_old");
});

test("a database with the legacy pi_sessions table opens unchanged; nothing reads or writes that table", async t => {
  const dir = await tmp(t);
  const first = new WebhookInbox(dir);
  await first.init();
  await first.close();
  const legacy = new DatabaseSync(join(dir, "webhooks.sqlite"));
  legacy.prepare("INSERT INTO pi_sessions (session_id, cwd, artifact_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("s-legacy", "/work", "/results", 10, 10);
  legacy.close();
  const reopened = new WebhookInbox(dir);
  t.after(() => reopened.close());
  assert.equal(await reopened.getSessionGroup("s-legacy"), undefined, "no group is implied by the legacy row");
  assert.equal(await reopened.getSessionGroup("s-search"), undefined);
  const check = new DatabaseSync(join(dir, "webhooks.sqlite"));
  try {
    assert.equal((check.prepare("SELECT COUNT(*) AS n FROM pi_sessions").get() as { n: number }).n, 1, "the legacy row is kept, not dropped");
  } finally {
    check.close();
  }
});

test("search activity is an immutable meta row and rejects payloads or unknown ids", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.saveSearchActivity({
    reference: "search_b", session_id: "s1", kind: "search", query: "later", status: "completed",
    provider_ids: { search_id: "srch_1", session_id: "ps_1" }, artifact: "/results/b.json", created_at: 20,
  });
  await inbox.saveSearchActivity({
    reference: "search_a", session_id: "s1", kind: "extract", query: "earlier", status: "partial",
    provider_ids: { extract_id: "ex_1" }, created_at: 5,
  });
  await inbox.saveSearchActivity({ reference: "search_other", session_id: "s2", kind: "entity", status: "failed", provider_ids: { entity_set_id: "ent_1" }, created_at: 1 });
  assert.deepEqual((await inbox.activitiesForSession("s1")).map(row => row.reference), ["search_a", "search_b"]);
  assert.equal((await inbox.activitiesForSession("s1"))[1]!.provider_ids?.search_id, "srch_1");
  await assert.rejects(() => inbox.saveSearchActivity({
    reference: "search_b", session_id: "s1", kind: "search", status: "failed", created_at: 30,
  }), /already exists/);
  assert.equal((await inbox.activitiesForSession("s1"))[1]!.status, "completed");
  await assert.rejects(() => inbox.saveSearchActivity({
    reference: "search_secret", session_id: "s1", kind: "search", status: "completed", created_at: 3,
    provider_ids: { api_key: "secret" } as never,
  }), /not allowed/);
  await assert.rejects(() => inbox.saveSearchActivity({
    reference: "search_long", session_id: "s1", kind: "search", status: "completed", query: "q".repeat(501), created_at: 4,
  }), /500/);
  assert.equal((await inbox.activitiesForSession("s1")).length, 2);
});

test("parent is fixed at creation and a known interaction id cannot be reassigned", async t => {
  const dir = await tmp(t);
  const inbox = new WebhookInbox(dir);
  await inbox.createResearch(research({ parent: "research_parent", interaction_id: undefined }));
  assert.equal((await inbox.getResearch(research().reference))?.parent, "research_parent");
  await inbox.updateResearch(research().reference, { parent: "research_parent", interaction_id: "int_1", status: "completed", artifact: "/a.json" });
  assert.equal((await inbox.getResearch(research().reference))?.interaction_id, "int_1");
  assert.equal((await inbox.getResearch(research().reference))?.run_id, undefined);
  assert.equal((await inbox.getResearch(research().reference))?.group_id, "tg_1");
  await inbox.updateResearch(research().reference, { interaction_id: "int_1" });
  await assert.rejects(() => inbox.updateResearch(research().reference, { interaction_id: "int_2" }), /interaction id cannot be reassigned/);
  await assert.rejects(() => inbox.updateResearch(research().reference, { parent: "research_other" }), /cannot be reassigned/);
  const kept = await inbox.getResearch(research().reference);
  assert.equal(kept?.interaction_id, "int_1");
  assert.equal(kept?.parent, "research_parent");
  assert.notEqual(kept?.interaction_id, kept?.group_id);
});
