import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore, type AlertKind, type AlertRecord } from "../src/store.ts";
import { createAlertDelivery, type AlertSink } from "../src/alert-delivery.ts";
import { createRecallService } from "../src/recall.ts";

async function harness(t: import("node:test").TestContext) {
  const dir = await mkdtemp(resolve(tmpdir(), "alert-delivery-"));
  const store = await new ResearchStore(dir).init();
  const live: { stop(): Promise<void> }[] = [];
  t.after(async () => {
    for (const delivery of live) await delivery.stop();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  let seq = 0;
  /** Queue one alert on a run (a new run unless one is given), as task collection does. */
  async function alert(kind: AlertKind, headline: string, reference?: string): Promise<string> {
    seq++;
    const ref = reference ?? (await store.beginRun({ sessionId: "s1", intentKey: `call-${seq}`, intent: {}, kind: "task", state: "accepted" })).reference;
    await store.enqueueAlert("s1", ref, { kind, headline, dedup_key: `${kind}:${ref}:${seq}` });
    return ref;
  }

  /** One runtime's delivery, with a sink that records what reached the agent. */
  function runtime(sink?: AlertSink, storeView: ResearchStore = store) {
    const delivered: AlertRecord[] = [];
    const errors: unknown[] = [];
    const alerts = createAlertDelivery({
      store: storeView,
      sessionId: "s1",
      deliver: sink ?? (record => { delivered.push(record); }),
      onError: err => { errors.push(err); },
    });
    live.push(alerts);
    return { alerts, delivered, errors };
  }

  const states = async () => (await store.alerts("s1")).map(record => record.state);
  return { store, alert, runtime, states };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolveGate => { open = resolveGate; });
  return { opened, open };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(resolveWait => setImmediate(resolveWait));
  assert.ok(check(), "condition not reached");
}

test("nothing is handed over before start; start hands over the most urgent alerts first", async t => {
  const h = await harness(t);
  await h.alert("progress", "still running");
  await h.alert("completion", "completed");
  await h.alert("failure", "failed");
  const rt = h.runtime();

  await rt.alerts.wake();
  assert.equal(rt.delivered.length, 0, "a wake-up before start hands nothing over");

  await rt.alerts.start();
  assert.deepEqual(rt.delivered.map(record => record.kind), ["failure", "completion", "progress"]);
  assert.deepEqual(await h.states(), ["delivered", "delivered", "delivered"], "delivered, not yet received");
});

test("concurrent wake-ups coalesce, so each alert is handed over once", async t => {
  const h = await harness(t);
  const rt = h.runtime();
  await rt.alerts.start();
  for (let i = 0; i < 3; i++) await h.alert("completion", `completed ${i}`);

  await Promise.all(Array.from({ length: 5 }, () => rt.alerts.wake()));
  assert.equal(rt.delivered.length, 3);
  assert.equal(new Set(rt.delivered.map(record => record.alert_id)).size, 3, "no alert was handed over twice");
});

test("an alert queued while a drain finds the queue empty is still handed over before it goes idle", async t => {
  const h = await harness(t);
  // The race that matters: the alert and its wake-up land while the drain's claim is
  // already returning nothing, so only the wake-up can make it look again.
  const racing = Object.create(h.store) as ResearchStore;
  let raced = false;
  racing.claimAlerts = async (sessionId, options) => {
    const batch = await h.store.claimAlerts(sessionId, options);
    if (!batch.length && !raced) {
      raced = true;
      await h.alert("completion", "late");
      void rt.alerts.wake();
    }
    return batch;
  };
  const rt = h.runtime(undefined, racing);
  await rt.alerts.start();
  assert.ok(raced);
  assert.deepEqual(rt.delivered.map(record => record.headline), ["late"]);
});

test("a failed hand-off is not delivery: the alert stays open and the next wake-up offers it again", async t => {
  const h = await harness(t);
  let attempts = 0;
  const delivered: string[] = [];
  const rt = h.runtime(record => {
    if (++attempts === 1) throw new Error("Pi refused the message");
    delivered.push(record.headline);
  });
  await h.alert("completion", "completed");

  await rt.alerts.start();
  assert.equal(delivered.length, 0);
  assert.match(String(rt.errors[0]), /Pi refused the message/, "the failure is reported, not swallowed");
  assert.deepEqual(await h.states(), ["claimed"], "still open");

  await rt.alerts.wake();
  assert.deepEqual(delivered, ["completed"]);
  assert.deepEqual(await h.states(), ["delivered"]);
});

test("a new runtime offers delivered alerts again until the agent has read the run", async t => {
  const h = await harness(t);
  const reference = await h.alert("completion", "completed");

  const first = h.runtime();
  await first.alerts.start();
  await first.alerts.stop();
  assert.equal(first.delivered.length, 1);

  const second = h.runtime();
  await second.alerts.start();
  assert.equal(second.delivered.length, 1, "handed over but never read: offered again, a duplicate rather than a loss");
  await second.alerts.received(reference);
  await second.alerts.stop();

  const third = h.runtime();
  await third.alerts.start();
  assert.equal(third.delivered.length, 0, "a read run's alerts are not offered again");
});

test("reading a run's evidence with web_recall is what acknowledges its alerts", async t => {
  const h = await harness(t);
  const byReference = (await h.store.beginRun({ sessionId: "s1", intentKey: "call-ref", intent: {}, kind: "task", state: "accepted" })).reference;
  const byHandle = (await h.store.beginRun({ sessionId: "s1", intentKey: "call-handle", intent: {}, kind: "task", state: "accepted" })).reference;
  let handle = "";
  for (const reference of [byReference, byHandle]) {
    const completion = await h.store.completeRun({
      sessionId: "s1", reference, state: "completed", summary: "done", rawResult: {},
      evidence: [{ kind: "report", origin: "provider_report", body: `report for ${reference}` }],
      alerts: [{ kind: "completion", headline: `Research completed: ${reference}`, dedup_key: `task-complete:${reference}` }],
    });
    handle = completion.evidence[0]!.handle;
  }

  const first = h.runtime();
  await first.alerts.start();
  assert.equal(first.delivered.length, 2);
  const recall = createRecallService({ store: h.store, sessionId: "s1", alerts: first.alerts });
  await recall.recall({ reference: byReference });
  await recall.recall({ handle });
  await first.alerts.stop();

  const second = h.runtime();
  await second.alerts.start();
  assert.equal(second.delivered.length, 0, "both runs were read, one by reference and one by handle");
});

test("stop during start waits for the takeover and hands nothing over", async t => {
  const h = await harness(t);
  await h.alert("completion", "completed");
  const release = gate();
  const slow = Object.create(h.store) as ResearchStore;
  slow.requeueUnacknowledgedAlerts = async sessionId => {
    await release.opened;
    return h.store.requeueUnacknowledgedAlerts(sessionId);
  };
  const rt = h.runtime(undefined, slow);
  void rt.alerts.start();

  let stopped = false;
  const stopping = rt.alerts.stop().then(() => { stopped = true; });
  await new Promise(resolveWait => setImmediate(resolveWait));
  assert.equal(stopped, false, "the store must not close under the takeover");
  release.open();
  await stopping;
  assert.equal(rt.delivered.length, 0);
  assert.deepEqual(rt.errors, []);
});

test("stop waits for a running drain and hands nothing over after it", async t => {
  const h = await harness(t);
  const release = gate();
  const delivered: string[] = [];
  const rt = h.runtime(async record => {
    delivered.push(record.headline);
    await release.opened;
  });
  await h.alert("completion", "first");
  await h.alert("completion", "second");
  void rt.alerts.start();
  await until(() => delivered.length === 1);

  let stopped = false;
  const stopping = rt.alerts.stop().then(() => { stopped = true; });
  await new Promise(resolveWait => setImmediate(resolveWait));
  assert.equal(stopped, false, "stop waits while an alert is being handed over");
  release.open();
  await stopping;

  await rt.alerts.wake();
  assert.equal(delivered.length, 1, "nothing is handed over after stop");
  assert.deepEqual((await h.states()).sort(), ["claimed", "delivered"], "the rest stays open for the next runtime");
});
