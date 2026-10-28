import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ResearchStore, StoreError } from "../src/store.ts";

const storeHref = pathToFileURL(fileURLToPath(new URL("../src/store.ts", import.meta.url))).href;

async function tmp(t: import("node:test").TestContext) {
  const dir = await mkdtemp(resolve(tmpdir(), "research-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function open(t: import("node:test").TestContext, options?: { now?: () => number }) {
  const dir = await tmp(t);
  const store = new ResearchStore(dir, options);
  await store.init();
  t.after(() => store.close());
  return { dir, store };
}

/** Complete one run with a single piece of evidence and return its handles. */
async function completedRun(store: ResearchStore, sessionId: string, intentKey: string, body: string, title = "Report") {
  const { reference } = await store.beginRun({ sessionId, intentKey, intent: { goal: title } });
  await store.bindProviderRun({ sessionId, reference, providerRunId: `trun_${intentKey}` });
  const result = await store.completeRun({
    sessionId,
    reference,
    state: "completed",
    evidence: [{ kind: "report", origin: "provider_report", title, body }],
    summary: title,
  });
  return { reference, handle: result.evidence[0]!.handle };
}

test("fresh store opens research.sqlite and never touches the legacy webtasks.sqlite", async t => {
  const dir = await tmp(t);
  const legacy = join(dir, "webtasks.sqlite");
  await writeFile(legacy, "legacy-bytes");
  const store = new ResearchStore(dir);
  await store.init();
  t.after(() => store.close());
  await store.registerSession("s1");
  assert.equal(store.path, join(dir, "research.sqlite"));
  assert.equal(await readFile(legacy, "utf8"), "legacy-bytes", "the old database must be left exactly as found");
});

test("session ownership gates reads, searches, and citation lookups", async t => {
  const { store } = await open(t);
  const a = await completedRun(store, "s1", "tool-a", "Postgres advisory locks behave differently from SQLite locks.", "Locking comparison");
  const b = await completedRun(store, "s2", "tool-b", "Private notes about a different session's sources.", "Private");

  await assert.rejects(() => store.readEvidence("s2", a.handle), (err: unknown) => err instanceof StoreError && err.code === "not_found");
  await assert.rejects(() => store.readEvidence("s1", b.handle), (err: unknown) => err instanceof StoreError && err.code === "not_found");
  assert.equal(await store.run("s2", a.reference), undefined, "a foreign run is indistinguishable from a missing one");
  await assert.rejects(
    () => store.completeRun({ sessionId: "s2", reference: a.reference, state: "failed" }),
    (err: unknown) => err instanceof StoreError && err.code === "not_found",
  );

  const own = await store.search("s1", { query: "advisory locks" });
  assert.equal(own.hits.length, 1, "the owner sees its own evidence");
  assert.equal(own.hits[0]!.reference, a.reference);
  const foreign = await store.search("s2", { query: "advisory locks" });
  assert.deepEqual(foreign.hits, [], "another session's matching evidence is invisible");

  assert.deepEqual((await store.listRuns("s2")).map(r => r.reference), [b.reference]);
  assert.equal((await store.stats("s1")).evidence, 1);
  assert.equal((await store.stats("s2")).evidence, 1);
});

test("beginRun is idempotent per tool invocation and separate per new invocation", async t => {
  const { store } = await open(t);
  const first = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "same text" } });
  const replay = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "same text" } });
  const second = await store.beginRun({ sessionId: "s1", intentKey: "call-2", intent: { goal: "same text" } });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.reference, first.reference, "a replayed invocation resolves to the run already paid for");
  assert.equal(second.created, true);
  assert.notEqual(second.reference, first.reference, "a deliberate new investigation stays separate");
  assert.equal((await store.listRuns("s1")).length, 2);
});

test("a run without an intent key is refused before any paid call", async t => {
  const { store } = await open(t);
  await assert.rejects(
    () => store.beginRun({ sessionId: "s1", intentKey: "", intent: {} }),
    (err: unknown) => err instanceof StoreError && err.code === "invalid",
  );
});

test("a parent run must belong to the same session", async t => {
  const { store } = await open(t);
  const foreign = await completedRun(store, "s2", "tool-x", "Foreign report body.");
  await assert.rejects(
    () => store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {}, parent: foreign.reference }),
    (err: unknown) => err instanceof StoreError && err.code === "invalid",
  );
});

test("completion commits payload, evidence, index, citations, state, and alert together", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "compare stores" }, processor: "core" });
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_1" });
  assert.equal((await store.run("s1", reference))?.state, "accepted", "binding confirms an unconfirmed run");

  const raw = { run: { run_id: "trun_1" }, output: { content: "Bash eats complexity; SQLite eats concurrency." } };
  const result = await store.completeRun({
    sessionId: "s1",
    reference,
    state: "completed",
    summary: "Storage comparison",
    rawResult: raw,
    evidence: [
      { kind: "report", origin: "provider_report", title: "Storage comparison", body: "Bash eats complexity; SQLite eats concurrency.", pointer: "output.content", ref: "report" },
      { kind: "source", origin: "provider_source", title: "inconshreveable", url: "https://example.test/bash", body: "Source text about bash.", ref: "source" },
    ],
    citations: [{ evidence: "report", source: "source", claim: "SQLite eats concurrency", url: "https://example.test/bash" }],
    alerts: [{ kind: "completion", headline: "Research completed: Storage comparison", dedup_key: "completion:trun_1" }],
  });

  assert.equal(result.changed, true);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.alertIds.length, 1);
  const run = await store.run("s1", reference);
  assert.equal(run?.state, "completed");
  assert.equal(run?.summary, "Storage comparison");
  assert.ok(run?.terminal_at, "a terminal state records when it settled");
  assert.deepEqual(await store.rawResult("s1", reference), raw, "the provider payload is preserved verbatim");

  assert.equal((await store.search("s1", { query: "concurrency" })).hits.length, 1, "the body is searchable in the same commit");
  assert.deepEqual(
    (await store.alerts("s1", { states: ["pending"] })).map(alert => alert.headline),
    ["Research completed: Storage comparison"],
  );
  const report = result.evidence[0]!.handle;
  const source = result.evidence[1]!.handle;
  assert.match((await store.readEvidence("s1", report)).text, /SQLite eats concurrency/);
  assert.deepEqual(await store.citations("s1", report), [
    { claim: "SQLite eats concurrency", url: "https://example.test/bash", title: undefined, sourceHandle: source },
  ]);
  const page = await store.search("s1", { reference, limit: 10 });
  assert.deepEqual(page.hits.map(hit => hit.handle).sort(), [report, source].sort(), "a run's evidence index is browsable");
});

test("a bad citation rolls back the whole completion", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "x" } });
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_rollback" });

  await assert.rejects(
    () => store.completeRun({
      sessionId: "s1",
      reference,
      state: "completed",
      evidence: [{ kind: "report", origin: "provider_report", body: "A body that must not survive the failed transaction." }],
      citations: [{ evidence: "ev_does_not_exist", claim: "x" }],
      alerts: [{ kind: "completion", headline: "should not exist", dedup_key: "completion:trun_rollback" }],
    }),
    (err: unknown) => err instanceof StoreError && err.code === "not_found",
  );

  const run = await store.run("s1", reference);
  assert.equal(run?.state, "accepted", "run state must be untouched");
  assert.equal((await store.stats("s1")).evidence, 0, "no evidence row survives");
  assert.equal((await store.stats("s1")).chars, 0);
  assert.deepEqual(await store.alerts("s1"), [], "no alert survives");
  assert.deepEqual((await store.search("s1", { query: "survive" })).hits, [], "no index entry survives");
});

test("citations resolve both batch aliases and stored handles within the session", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {} });
  const first = await store.completeRun({
    sessionId: "s1",
    reference,
    state: "completed",
    evidence: [
      { kind: "report", origin: "provider_report", body: "A claim needing support.", ref: "report" },
      { kind: "source", origin: "provider_source", url: "https://example.test/source", body: "Supporting text." },
    ],
    citations: [{ evidence: "report", claim: "alias citation" }],
  });
  assert.deepEqual(await store.citations("s1", first.evidence[0]!.handle), [
    { claim: "alias citation", url: undefined, title: undefined, sourceHandle: undefined },
  ]);

  const sourceHandle = first.evidence[1]!.handle;
  const { reference: second } = await store.beginRun({ sessionId: "s1", intentKey: "call-2", intent: {} });
  const later = await store.completeRun({
    sessionId: "s1",
    reference: second,
    state: "completed",
    evidence: [{ kind: "report", origin: "provider_report", body: "A claim citing earlier evidence.", ref: "report" }],
    citations: [{ evidence: "report", source: sourceHandle, claim: "cross-run citation" }],
  });
  assert.deepEqual(await store.citations("s1", later.evidence[0]!.handle), [
    { claim: "cross-run citation", url: undefined, title: undefined, sourceHandle },
  ]);

  await assert.rejects(
    () => store.citations("s2", later.evidence[0]!.handle),
    (err: unknown) => err instanceof StoreError && err.code === "not_found",
    "a citation read is session-scoped like any other handle",
  );
});

test("a stored result cannot be rewritten by a weaker later event", async t => {
  const { store } = await open(t);
  const a = await completedRun(store, "s1", "call-1", "First body.");
  const duplicate = await store.completeRun({
    sessionId: "s1",
    reference: a.reference,
    state: "completed",
    evidence: [{ kind: "report", origin: "provider_report", body: "A duplicate completion must not add evidence." }],
  });
  assert.equal(duplicate.changed, false, "the same terminal state is a harmless duplicate");
  assert.equal((await store.stats("s1")).evidence, 1);
  await assert.rejects(
    () => store.completeRun({ sessionId: "s1", reference: a.reference, state: "failed" }),
    (err: unknown) => err instanceof StoreError && err.code === "conflict",
  );
  await assert.rejects(
    () => store.setRunState({ sessionId: "s1", reference: a.reference, state: "pending" }),
    (err: unknown) => err instanceof StoreError && err.code === "conflict",
  );
});

test("the provider payload is preserved verbatim", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "x" } });
  const raw = { output: { content: "Report text", basis: [{ field: "content", citations: [{ url: "https://example.test", excerpts: ["quoted"] }] }] } };
  await store.completeRun({
    sessionId: "s1",
    reference,
    state: "completed",
    rawResult: raw,
    evidence: [{ kind: "report", origin: "provider_report", body: "Report text" }],
  });
  assert.deepEqual(await store.rawResult("s1", reference), raw);
});

test("an uncertain submission is not terminal and can be reconciled", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "x" }, state: "submitting" });
  await store.setRunState({ sessionId: "s1", reference, state: "uncertain", error: "connection lost" });
  assert.equal((await store.run("s1", reference))?.state, "uncertain");
  // A later confirmed outcome may still settle the same run, without resubmitting.
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_recovered" });
  await store.completeRun({
    sessionId: "s1",
    reference,
    state: "completed",
    evidence: [{ kind: "report", origin: "provider_report", body: "Recovered output." }],
  });
  assert.equal((await store.run("s1", reference))?.state, "completed");
});

test("binding a second provider run to one local run is a conflict", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "x" } });
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_a" });
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_a" });
  await assert.rejects(
    () => store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_b" }),
    (err: unknown) => err instanceof StoreError && err.code === "conflict",
  );
  assert.equal((await store.runByProviderId("s1", "trun_a"))?.reference, reference);
});

test("evidence search ranks, highlights, filters, and survives punctuation", async t => {
  const { store } = await open(t);
  const first = await completedRun(store, "s1", "call-1", "Advisory locks in PostgreSQL require explicit handling. Locks matter.", "Postgres locking");
  const second = await completedRun(store, "s1", "call-2", "SQLite uses file-level locking by default.", "SQLite locking");

  const all = await store.search("s1", { query: "locking" });
  assert.equal(all.hits.length, 2);
  assert.ok(all.hits.every(hit => hit.snippet.includes("[")), "each hit carries a highlight");
  assert.ok(all.hits.some(hit => hit.reference === first.reference));
  assert.ok(all.hits.some(hit => hit.reference === second.reference));

  const filtered = await store.search("s1", { query: "locking", reference: first.reference });
  assert.deepEqual(filtered.hits.map(hit => hit.reference), [first.reference]);

  const byKind = await store.search("s1", { query: "locking", kinds: ["source"] });
  assert.deepEqual(byKind.hits, [], "a kind filter excludes other evidence kinds");

  const punctuation = await store.search("s1", { query: "what about advisory-locks?! (postgres)" });
  assert.equal(punctuation.hits.length, 2, "punctuation never becomes an FTS syntax error");
  assert.deepEqual(punctuation.hits.map(hit => hit.reference).sort(), [first.reference, second.reference].sort());

  const empty = await store.search("s1", { query: "???" });
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.more, false);
});

test("search pages stay stable while new evidence arrives", async t => {
  const { store } = await open(t);
  for (let i = 1; i <= 5; i++) {
    const { reference: runRef } = await store.beginRun({ sessionId: "s1", intentKey: `call-${i}`, intent: {} });
    await store.completeRun({
      sessionId: "s1",
      reference: runRef,
      state: "completed",
      evidence: [{ kind: "finding", origin: "provider_finding", title: `Finding ${i}`, body: `Finding number ${i} about storage engines.` }],
    });
  }
  const page1 = await store.search("s1", { limit: 2 });
  assert.equal(page1.hits.length, 2);
  assert.equal(page1.more, true);
  assert.ok(page1.next_cursor);

  // New evidence arrives between pages; it must not shift the pinned sequence.
  const late = await store.beginRun({ sessionId: "s1", intentKey: "call-late", intent: {} });
  await store.completeRun({
    sessionId: "s1",
    reference: late.reference,
    state: "completed",
    evidence: [{ kind: "finding", origin: "provider_finding", title: "Late", body: "Late finding." }],
  });

  const page2 = await store.search("s1", { limit: 2, cursor: page1.next_cursor });
  assert.equal(page2.snapshot, page1.snapshot);
  const page3 = await store.search("s1", { limit: 2, cursor: page2.next_cursor });
  const seen = [...page1.hits, ...page2.hits, ...page3.hits].map(hit => hit.handle);
  assert.equal(seen.length, 5, "three pages cover every pre-snapshot finding exactly once");
  assert.equal(new Set(seen).size, 5, "no handle repeats across pages");
  assert.equal(page3.more, false);
  assert.equal(page3.next_cursor, undefined);

  const lateHit = (await store.search("s1", { query: "late" })).hits[0]!;
  assert.ok(!seen.includes(lateHit.handle), "evidence stored after page one stays outside the pinned snapshot");
  assert.ok(lateHit.created_at >= 0 && (await store.search("s1", {})).snapshot > page1.snapshot, "a fresh search sees it");

  await assert.rejects(
    () => store.search("s1", { cursor: "not-a-cursor" }),
    (err: unknown) => err instanceof StoreError && err.code === "invalid",
  );
});

test("bounded reads slice by offset without splitting a surrogate pair", async t => {
  const { store } = await open(t);
  const body = "a🙂b🙂c🙂d";
  const { handle } = await completedRun(store, "s1", "call-1", body);

  const slices: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard++) {
    const slice = await store.readEvidence("s1", handle, { offset, limit: 2 });
    assert.equal(slice.total_chars, body.length);
    slices.push(slice.text);
    if (slice.next_offset === undefined) break;
    assert.ok(slice.next_offset > offset, "progress is monotonic");
    offset = slice.next_offset;
  }
  assert.equal(slices.join(""), body, "concatenated slices reproduce the stored body");
  assert.ok(slices.every(slice => !slice.includes("\ud83d") || slice.includes("\ud83d\ude42")), "no lone surrogate is returned");

  const whole = await store.readEvidence("s1", handle);
  assert.equal(whole.text, body);
  assert.equal(whole.truncated_after, false);
  assert.equal(whole.next_offset, undefined);

  const past = await store.readEvidence("s1", handle, { offset: 999 });
  assert.equal(past.text, "");
  assert.equal(past.truncated_before, true);
  assert.equal(past.truncated_after, false);

  await assert.rejects(() => store.readEvidence("s1", "ev_missing"), (err: unknown) => err instanceof StoreError && err.code === "not_found");
});

test("observations dedup replays but never merge distinct events that merely share text", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {} });

  const first = await store.appendObservation({
    sessionId: "s1", reference, source: "run_sse", eventType: "task_run.progress",
    dedupKey: "run_sse:progress:2026-10-27T00:00:00Z", payload: { message: "Searching", seq: 1 },
  });
  const replay = await store.appendObservation({
    sessionId: "s1", reference, source: "run_sse", eventType: "task_run.progress",
    dedupKey: "run_sse:progress:2026-10-27T00:00:00Z", payload: { message: "Searching", seq: 1 },
  });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);

  const distinct = await store.appendObservation({
    sessionId: "s1", reference, source: "run_sse", eventType: "task_run.progress",
    dedupKey: "run_sse:progress:2026-10-27T00:01:00Z", payload: { message: "Searching", seq: 1 },
  });
  assert.equal(distinct.duplicate, false, "identical text at a different event identity stays a separate event");

  const cursorless = await store.appendObservation({ sessionId: "s1", reference, source: "run_sse", eventType: "statistics", payload: { n: 3 } });
  const cursorless2 = await store.appendObservation({ sessionId: "s1", reference, source: "run_sse", eventType: "statistics", payload: { n: 3 } });
  assert.notEqual(cursorless.id, cursorless2.id, "events without a stable id are stored, not silently dropped");

  const events = await store.observations("s1", reference);
  assert.equal(events.length, 4);
  assert.deepEqual(events[0]!.payload, { message: "Searching", seq: 1 });
  const after = await store.observations("s1", reference, { afterId: events[1]!.id, limit: 2 });
  assert.deepEqual(after.map(event => event.id), [cursorless.id, cursorless2.id]);
  assert.deepEqual(await store.observations("s2", reference).catch(() => "denied"), "denied", "another session cannot read observations");
});

test("alerts coalesce, prioritize terminal states, and survive a crash without being lost", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {} });

  const progressId = await store.enqueueAlert("s1", reference, { kind: "progress", headline: "Still running", dedup_key: "progress:1" });
  await store.enqueueAlert("s1", reference, { kind: "progress", headline: "Still running (2)", dedup_key: "progress:1" });
  await store.enqueueAlert("s1", reference, { kind: "progress", headline: "Still running", dedup_key: "progress:2" });
  assert.equal((await store.alerts("s1")).length, 2, "a repeated key coalesces into one row");
  await store.completeRun({
    sessionId: "s1",
    reference,
    state: "failed",
    error: "provider failed",
    alerts: [{ kind: "failure", headline: "Research failed", dedup_key: "failure:1" }],
  });

  const claimed = await store.claimAlerts("s1", { limit: 2 });
  assert.equal(claimed[0]!.kind, "failure", "a terminal alert is delivered before further progress");
  assert.equal(claimed[0]!.attempts, 1);
  assert.ok(claimed.every(alert => alert.state === "claimed"));

  await store.markAlertDelivered("s1", claimed[0]!.alert_id);
  const delivered = (await store.alerts("s1")).find(alert => alert.alert_id === claimed[0]!.alert_id)!;
  assert.equal(delivered.state, "delivered", "handoff is not acknowledgement");

  // Simulated crash: the runtime is gone, so every unacknowledged handoff is eligible again.
  assert.equal(await store.requeueUnacknowledgedAlerts("s1"), 2);
  const reoffered = await store.claimAlerts("s1");
  assert.ok(reoffered.some(alert => alert.alert_id === claimed[0]!.alert_id));
  assert.equal(reoffered.find(alert => alert.alert_id === claimed[0]!.alert_id)!.attempts, 2);

  await store.acknowledgeAlert("s1", claimed[0]!.alert_id);
  const after = await store.alerts("s1");
  assert.equal(after.find(alert => alert.alert_id === claimed[0]!.alert_id)!.state, "acknowledged");
  assert.ok(!(await store.claimAlerts("s1")).some(alert => alert.alert_id === claimed[0]!.alert_id), "an acknowledged alert is never re-delivered");
  assert.ok(progressId);

  // An acknowledged dedup key stays acknowledged instead of being reopened.
  await store.enqueueAlert("s1", reference, { kind: "failure", headline: "Replayed failure", dedup_key: "failure:1" });
  assert.equal(
    (await store.alerts("s1")).find(alert => alert.alert_id === claimed[0]!.alert_id)!.state,
    "acknowledged",
  );
});

test("an alert cannot be claimed for another session", async t => {
  const { store } = await open(t);
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {} });
  const alertId = await store.enqueueAlert("s1", reference, { kind: "progress", headline: "x", dedup_key: "progress:1" });
  assert.deepEqual(await store.claimAlerts("s2"), []);
  await store.acknowledgeAlert("s2", alertId);
  assert.equal((await store.alerts("s1")).find(alert => alert.alert_id === alertId)!.state, "pending", "another session cannot acknowledge it");
});

test("group binding is per session and the event cursor is explicit", async t => {
  const { store } = await open(t);
  await store.bindGroup("s1", "tgrp_1", "ready");
  await store.bindGroup("s2", "tgrp_2", "ready");
  assert.equal((await store.groupForSession("s1"))?.group_id, "tgrp_1");
  assert.equal((await store.groupForSession("s2"))?.group_id, "tgrp_2");
  await store.setGroupCursor("s1", "cursor-7");
  assert.equal((await store.groupForSession("s1"))?.event_cursor, "cursor-7");
  assert.equal((await store.groupForSession("s2"))?.event_cursor, undefined);
});

test("a failed index write rolls back the completion instead of reporting a result", async t => {
  const dir = await tmp(t);
  const store = new ResearchStore(dir);
  await store.init();
  const { reference } = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {} });
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_index_fail" });

  // Simulate an indexing failure with a second connection: the evidence insert
  // succeeds, then the FTS write fails, and everything must roll back.
  const other = new DatabaseSync(store.path);
  other.exec("DROP TABLE evidence_fts");
  other.close();

  await assert.rejects(() => store.completeRun({
    sessionId: "s1",
    reference,
    state: "completed",
    evidence: [{ kind: "report", origin: "provider_report", body: "body that must not commit" }],
  }));
  assert.equal((await store.run("s1", reference))?.state, "accepted");
  assert.equal((await store.stats("s1")).evidence, 0);
  await store.close();

  // Reopening recreates the index table; the run is still recoverable, not fake-completed.
  const reopened = new ResearchStore(dir);
  await reopened.init();
  assert.equal((await reopened.run("s1", reference))?.state, "accepted");
  t.after(() => reopened.close());
});

test("an interrupted request becomes uncertain instead of looking unfinished forever", async t => {
  const { store } = await open(t);
  const interrupted = await store.beginRun({ sessionId: "s1", intentKey: "call-1", intent: {}, kind: "search", state: "submitting" });
  const task = await store.beginRun({ sessionId: "s1", intentKey: "call-2", intent: {}, kind: "task", state: "submitting" });
  const finished = await completedRun(store, "s1", "call-3", "A completed body that stays completed.");

  assert.equal(await store.reconcileInterrupted("s1", { olderThanMs: 0 }), 1, "only the synchronous request is settled locally");
  assert.equal((await store.run("s1", interrupted.reference))?.state, "uncertain");
  assert.match((await store.run("s1", interrupted.reference))?.error ?? "", /interrupted before the result was stored/);
  assert.equal((await store.run("s1", task.reference))?.state, "submitting", "a Task run waits for provider reconciliation");
  assert.equal((await store.run("s1", finished.reference))?.state, "completed");

  // A request that is still recent is left alone: another runtime may still be working on it.
  const recent = await store.beginRun({ sessionId: "s1", intentKey: "call-4", intent: {}, kind: "search", state: "submitting" });
  assert.equal(await store.reconcileInterrupted("s1"), 0);
  assert.equal((await store.run("s1", recent.reference))?.state, "submitting");
});

test("an older store is migrated in place before the schema indexes run", async t => {
  const dir = await tmp(t);
  const created = new ResearchStore(dir);
  await created.init();
  const begun = await created.beginRun({ sessionId: "s1", intentKey: "call-1", intent: { goal: "x" }, state: "accepted" });
  await created.close();

  // Recreate the shape an earlier build of this rewrite wrote: four missing columns, version 1.
  const raw = new DatabaseSync(join(dir, "research.sqlite"));
  for (const column of ["provider_interaction_id", "running_at", "next_alert_at", "alert_interval_ms"]) {
    raw.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
  }
  raw.exec("PRAGMA user_version = 1");
  raw.close();

  const reopened = new ResearchStore(dir);
  await reopened.init();
  t.after(() => reopened.close());
  const columns = (await reopened.schemaColumns("runs"));
  for (const column of ["provider_interaction_id", "running_at", "next_alert_at", "alert_interval_ms"]) {
    assert.ok(columns.includes(column), `${column} was added`);
  }
  assert.deepEqual(await reopened.runsNeedingProgress("s1"), [], "the sweeper query works after migration");
  assert.equal(await reopened.markRunning("s1", begun.reference, 100), true);
  const running = await reopened.run("s1", begun.reference);
  assert.equal(running?.next_alert_at, running!.running_at! + 100);
  assert.equal(await reopened.schemaVersion(), 2);
});

test("deleteRun removes the run and keeps the search index in step", async t => {
  const { store } = await open(t);
  const { reference } = await completedRun(store, "s1", "call-1", "Ephemeral finding about walrus migration.");
  assert.equal((await store.search("s1", { query: "walrus" })).hits.length, 1);
  await store.deleteRun("s1", reference);
  assert.deepEqual((await store.search("s1", { query: "walrus" })).hits, [], "no stale index row remains");
  assert.equal((await store.listRuns("s1")).length, 0);
  assert.equal((await store.alerts("s1")).length, 0);
});

test("deleteRun keeps continuations of the deleted run", async t => {
  const { store } = await open(t);
  const { reference } = await completedRun(store, "s1", "call-1", "Parent finding.");
  const child = await store.beginRun({ sessionId: "s1", intentKey: "call-2", intent: {}, parent: reference });
  await store.deleteRun("s1", reference);
  const kept = await store.run("s1", child.reference);
  assert.ok(kept, "the continuation survives");
  assert.equal(kept.parent, undefined);
});

test("a late running observation or bind cannot reopen a settled run", async t => {
  const { store } = await open(t);
  const { reference } = await completedRun(store, "s1", "call-1", "Settled.");
  assert.equal(await store.markRunning("s1", reference, 100), false);
  await store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_call-1", interactionId: "int_late" });
  assert.equal(await store.transitionRun({ sessionId: "s1", reference, from: new Set(["completed", "accepted"]), to: "action_required" }), false);
  assert.equal((await store.run("s1", reference))?.state, "completed");
  assert.equal(await store.queueProgress("s1", reference, { kind: "progress", headline: "late", dedup_key: "late" }), false);
  assert.equal((await store.alerts("s1")).filter(alert => alert.kind === "progress").length, 0, "no progress alert for a settled run");
});

test("two processes racing the same tool invocation create exactly one run", async t => {
  const dir = await tmp(t);
  const child = `
    import(${JSON.stringify(storeHref)}).then(async ({ ResearchStore }) => {
      const store = new ResearchStore(${JSON.stringify(dir)});
      await store.init();
      const out = await store.beginRun({ sessionId: "s1", intentKey: "tool-call-race", intent: { goal: "same" } });
      console.log(JSON.stringify(out));
      await store.close();
    }).catch(err => { console.error(err); process.exit(2); });
  `;
  const outputs = await new Promise<string[]>((done) => {
    const collected: string[] = [];
    let remaining = 2;
    for (let i = 0; i < 2; i++) {
      execFile(process.execPath, ["--experimental-strip-types", "-e", child], (err, stdout, stderr) => {
        collected.push(stdout.trim() || `child failed (${err?.code ?? "no output"}): ${stderr.trim()}`);
        if (--remaining === 0) done(collected);
      });
    }
  });
  for (const line of outputs) assert.ok(line.startsWith("{"), line);
  const results = outputs.map(line => JSON.parse(line) as { reference: string; created: boolean });
  assert.equal(results.filter(result => result.created).length, 1, `exactly one racer may create the run; got ${JSON.stringify(results)}`);
  assert.equal(new Set(results.map(result => result.reference)).size, 1, "both racers converge on the same reference");

  const store = new ResearchStore(dir);
  await store.init();
  t.after(() => store.close());
  assert.equal((await store.listRuns("s1")).length, 1, "no second paid run was recorded");
});
