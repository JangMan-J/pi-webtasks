// Pi's loader, registered deep_search, real SQLite, signed loopback HTTP, and
// receiver-side result processing. Outbound Parallel responses are fixtures;
// these tests do not establish public provider delivery or model navigation.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Parallel from "parallel-web";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import { startWebhookReceiver } from "../src/webhook-receiver.ts";
import { WebhookWorker } from "../src/webhook-worker.ts";
import { setup } from "./helpers/test-host.ts";

const REAL_FETCH = globalThis.fetch;
const SECRET = "whsec_dGVzdHNlY3JldA==";

function json(value: unknown): Response {
  return Response.json(value);
}

async function deliver(url: string, id: string, event: unknown): Promise<number> {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`${id}.${timestamp}.${body}`).digest("base64");
  const response = await REAL_FETCH(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
  return response.status;
}

/** Outbound collector polls (GET events and runs). Webhook lifecycle assertions exclude them. */
const isPoll = (c: { method: string; path: string }) => c.method === "GET" && /\/v1\/tasks\/groups\/[^/]+\/(events|runs)$/.test(c.path);
const remote = (calls: { method: string; path: string }[]) => calls.filter(c => !isPoll(c)).map(c => c.path);

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.ok(await check(), "lifecycle condition not met before timeout");
}

test("registered deep_search -> signed callback -> saved evidence -> one owning-session wakeup", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1/tasks/groups") return json({ taskgroup_id: "tgrp_e2e" });
    if (path === "/v1/tasks/groups/tgrp_e2e/runs") return json({ run_ids: ["trun_e2e"] });
    if (path === "/v1/tasks/runs/trun_e2e/result") {
      return json({ run: { run_id: "trun_e2e", interaction_id: "interaction_e2e" }, output: { content: "answer" } });
    }
    throw new Error(`Unexpected outbound path: ${path}`);
  });
  const dir = join(h.dir, "webhooks");
  process.env.WEBTASKS_DIR = dir;
  const inbox = new WebhookInbox(dir);
  const worker = new WebhookWorker({
    inbox, artifactDir: h.artifacts, cwd: h.dir,
    getClient: async () => new Parallel({ apiKey: "offline-only", maxRetries: 0 }),
  });
  const receiver = await startWebhookReceiver({ inbox, secret: SECRET, port: 0, onAccepted: () => worker.kick() });
  process.env.WEBTASKS_WEBHOOK_URL = receiver.url;
  const owner = await h.instance("s-e2e-owner");
  try {
    await worker.start();
    await owner.start();
    assert.equal(await inbox.getSessionGroup("s-e2e-owner"), undefined);
    assert.equal(h.calls.length, 0, "startup must not create a remote group");

    const created = await owner.call("deep_search", { query: "objective" });
    const reference = created.details.references[0];
    assert.match(reference, /^research_/);
    const input = h.calls.find(c => c.path.endsWith("/runs"))!.body.inputs[0];
    assert.deepEqual(input.webhook, { url: receiver.url, event_types: ["task_run.status"] });
    assert.equal(input.metadata.webtasks_ref, reference);
    assert.equal(input.metadata.webtasks_session, "s-e2e-owner");
    assert.equal((await inbox.getRegistration("trun_e2e"))?.session_id, "s-e2e-owner");

    const event = { type: "task_run.status", data: { run_id: "trun_e2e", status: "completed" } };
    assert.equal(await deliver(receiver.url, "wh-e2e", event), 200);
    await waitFor(() => owner.sent.length === 1);
    const sent: any = owner.sent[0];
    assert.equal(sent.message.customType, "webtasks-research");
    assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(sent.message.display, true);
    assert.equal(sent.message.details.reference, reference);
    assert.equal(sent.message.details.status, "completed");
    assert.ok(sent.message.content.includes(reference));
    assert.ok(!sent.message.content.includes("trun_e2e"));
    assert.equal(JSON.parse(await readFile(sent.message.details.artifact, "utf8")).output.content, "answer");
    await waitFor(async () => !(await inbox.listHandledUnnotified()).some(e => e.webhook_id === "wh-e2e"));

    assert.equal(await deliver(receiver.url, "wh-e2e", event), 200);
    await delay(600);
    assert.equal(owner.sent.length, 1, "duplicate callback must not wake the owner twice");
    assert.deepEqual(remote(h.calls), [
      "/v1/tasks/groups", "/v1/tasks/groups/tgrp_e2e/runs", "/v1/tasks/runs/trun_e2e/result",
    ]);
  } finally {
    await owner.stop();
    await worker.stop();
    await receiver.close();
    await inbox.close();
  }
});

test("stopped owner: receiver saves evidence, foreign session stays silent, resume delivers without another GET", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1/tasks/groups") return json({ taskgroup_id: "tgrp_offline" });
    if (path === "/v1/tasks/groups/tgrp_offline/runs") return json({ run_ids: ["trun_offline"] });
    if (path === "/v1/tasks/runs/trun_offline/result") {
      return json({ run: { run_id: "trun_offline", interaction_id: "interaction_offline" }, output: { content: "offline answer" } });
    }
    throw new Error(`Unexpected outbound path: ${path}`);
  });
  const dir = join(h.dir, "webhooks");
  process.env.WEBTASKS_DIR = dir;
  const inbox = new WebhookInbox(dir);
  const worker = new WebhookWorker({
    inbox, artifactDir: join(h.dir, "wrong-fallback"), cwd: h.dir,
    getClient: async () => new Parallel({ apiKey: "offline-only", maxRetries: 0 }),
  });
  const receiver = await startWebhookReceiver({ inbox, secret: SECRET, port: 0, onAccepted: () => worker.kick() });
  process.env.WEBTASKS_WEBHOOK_URL = receiver.url;
  const owner = await h.instance("s-offline-owner");
  const stranger = await h.instance("s-not-the-owner");
  let resumed: any;
  try {
    await worker.start();
    await owner.start();
    const created = await owner.call("deep_search", { query: "offline objective" });
    const reference = created.details.references[0];
    await owner.stop();
    assert.equal(remote(h.calls).length, 2, "session stop must not drain remote work");
    const pollsAtStop = h.calls.filter(isPoll).length;
    await stranger.start();
    assert.equal(await deliver(receiver.url, "wh-offline", {
      type: "task_run.status", data: { run_id: "trun_offline", status: "completed" },
    }), 200);
    await waitFor(async () => (await inbox.getResearch(reference))?.status === "completed");
    const record = (await inbox.getResearch(reference))!;
    assert.ok(record.artifact?.startsWith(h.artifacts), "worker must use the persisted owner artifact directory");
    assert.equal(JSON.parse(await readFile(record.artifact!, "utf8")).output.content, "offline answer");
    assert.equal(owner.sent.length, 0);
    assert.equal(stranger.sent.length, 0, "foreign session must never deliver the owner's outcome");
    assert.ok((await inbox.listHandledUnnotified()).some(e => e.webhook_id === "wh-offline"));
    const paths = remote(h.calls);

    resumed = await h.instance("s-offline-owner");
    await resumed.start();
    assert.equal(resumed.sent.length, 1);
    assert.equal(resumed.sent[0].message.details.reference, reference);
    assert.equal(resumed.sent[0].message.details.status, "completed");
    assert.deepEqual(remote(h.calls), paths, "resume must use saved evidence, not fetch again");
    assert.equal((await inbox.listHandledUnnotified()).length, 0);
    const read = await resumed.call("deep_search", { research: reference });
    assert.ok(read.text.includes("offline answer"));
    assert.deepEqual(remote(h.calls), paths, "completed reference reads do not create or fetch");
    assert.equal(h.calls.filter(isPoll).length, pollsAtStop, "a stopped owner makes no polls; the resumed owner has nothing pending");
  } finally {
    await resumed?.stop();
    await stranger.stop();
    await owner.stop();
    await worker.stop();
    await receiver.close();
    await inbox.close();
  }
});

test("signed matching metadata completes before addRuns returns without losing the terminal outcome", async t => {
  let inbox: WebhookInbox;
  let receiverUrl: string;
  let reference: string;
  const h = await setup(t, async ({ path, body }) => {
    if (path === "/v1/tasks/groups") return json({ taskgroup_id: "tgrp_early" });
    if (path === "/v1/tasks/groups/tgrp_early/runs") {
      reference = body.inputs[0].metadata.webtasks_ref;
      assert.equal(await deliver(receiverUrl, "wh-early", {
        type: "task_run.status",
        data: { run_id: "trun_early", status: "completed", metadata: body.inputs[0].metadata },
      }), 200);
      await waitFor(async () => (await inbox.getResearch(reference))?.status === "completed");
      return json({ run_ids: ["trun_early"] });
    }
    if (path === "/v1/tasks/runs/trun_early/result") {
      return json({ run: { run_id: "trun_early", interaction_id: "interaction_early" }, output: { content: "early answer" } });
    }
    throw new Error(`Unexpected outbound path: ${path}`);
  });
  const dir = join(h.dir, "webhooks");
  process.env.WEBTASKS_DIR = dir;
  inbox = new WebhookInbox(dir);
  const worker = new WebhookWorker({
    inbox, artifactDir: h.artifacts, cwd: h.dir,
    getClient: async () => new Parallel({ apiKey: "offline-only", maxRetries: 0 }),
  });
  const receiver = await startWebhookReceiver({ inbox, secret: SECRET, port: 0, onAccepted: () => worker.kick() });
  receiverUrl = process.env.WEBTASKS_WEBHOOK_URL = receiver.url;
  const owner = await h.instance("s-early-owner");
  try {
    await worker.start();
    await owner.start();
    const created = await owner.call("deep_search", { query: "early completion" });
    assert.equal(created.details.references[0], reference!);
    assert.equal((await inbox.getResearch(reference!))?.status, "completed");
    assert.equal((await inbox.getResearch(reference!))?.run_id, "trun_early");
    await waitFor(() => owner.sent.length === 1);
    assert.equal(h.calls.filter(c => c.path.endsWith("/result")).length, 1);
    assert.equal((await owner.call("deep_search", { research: reference! })).text.includes("early answer"), true);
  } finally {
    await owner.stop();
    await worker.stop();
    await receiver.close();
    await inbox.close();
  }
});
