import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startWebhookReceiver } from "../src/webhook-receiver.ts";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import { WebhookWorker } from "../src/webhook-worker.ts";
import { AGENT_BUS_PATH } from "../src/agent-bus.ts";
import { setup, extensionDir, packageDir } from "./helpers/test-host.ts";

const realFetch = globalThis.fetch;
const busSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const researchSecret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const event = {
  type: "agent_bus.message",
  data: { agent: "alice", message: { id: 1, ts: 123, sender: "bob", recipient: "alice", body: "Please read the update.", data: null, visibility: "private" } },
};

async function post(url: string, id: string, value: unknown, secret = busSecret): Promise<number> {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${body}`).digest("base64");
  const response = await realFetch(url, {
    method: "POST", body,
    headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
  });
  await response.text();
  return response.status;
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "expected webhook condition before deadline");
    await delay(10);
  }
}

test("signed bus callback wakes only its bound Pi session; closed owners recover and duplicates stay quiet", async t => {
  const h = await setup(t, () => { throw new Error("bus notification must not call Parallel"); });
  const dir = join(h.dir, "inbox");
  process.env.WEBTASKS_DIR = dir;
  const inbox = new WebhookInbox(join(dir, "agent-bus"));
  const worker = new WebhookWorker({
    inbox, artifactDir: h.artifacts,
    getClient: async () => { throw new Error("bus notification must not fetch a result"); },
  });
  const receiver = await startWebhookReceiver({ inbox, agentBusSecret: busSecret, port: 0, onAccepted: () => worker.kick() });
  const url = new URL(AGENT_BUS_PATH, receiver.url).href;
  const owner = await h.instance("bus-owner");
  const stranger = await h.instance("stranger");
  let resumed: typeof owner | undefined;
  try {
    await worker.start();
    await owner.start();
    await stranger.start();
    assert.equal(owner.tools.get("agent_bus_listen").exposure, "deferred");
    await owner.call("agent_bus_listen", { agent: "alice" });
    await assert.rejects(stranger.call("agent_bus_listen", { agent: "alice" }), /already registered/);
    assert.equal(await post(url, "first", event), 200);
    await waitFor(() => owner.sent.length === 1);
    assert.equal(owner.sent[0].message.customType, "agent-bus");
    assert.deepEqual(owner.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(owner.sent[0].message.content, /Please read the update/);
    assert.equal(stranger.sent.length, 0);
    await waitFor(async () => (await inbox.listAll()).find(e => e.webhook_id === "bus:first")?.notified === true);
    assert.equal(await post(url, "first", event), 200);
    await owner.stop();
    assert.equal(await post(url, "second", { ...event, data: { ...event.data, message: { ...event.data.message, id: 2 } } }), 200);
    await worker.recover();
    resumed = await h.instance("bus-owner");
    await resumed.start();
    assert.equal(resumed.sent.length, 1);
    assert.equal(resumed.sent[0].message.details.messageId, 2);
    assert.equal(stranger.sent.length, 0);
    assert.equal(h.calls.length, 0);
  } finally {
    await resumed?.stop();
    await owner.stop();
    await stranger.stop();
    await worker.stop();
    await receiver.close();
    await inbox.close();
  }
});

test("bus and research signing keys and event types are isolated; unmatched bus events are retained", async t => {
  const h = await setup(t, () => { throw new Error("unexpected fetch"); });
  const inbox = new WebhookInbox(join(h.dir, "inbox"));
  const receiver = await startWebhookReceiver({ inbox, secret: researchSecret, agentBusSecret: busSecret, port: 0 });
  const url = new URL(AGENT_BUS_PATH, receiver.url).href;
  const worker = new WebhookWorker({ inbox, artifactDir: h.artifacts, getClient: async () => { throw new Error("unexpected fetch"); } });
  try {
    assert.equal(await post(url, "cross-key", event, researchSecret), 401);
    assert.equal(await post(receiver.url, "cross-route", event, researchSecret), 400);
    assert.equal(await post(url, "bad-recipient", { ...event, data: { ...event.data, agent: "charlie" } }), 400);
    assert.equal(await post(url, "not-bus", { type: "task_run.status", data: { run_id: "fake", status: "completed" } }), 400);
    assert.equal((await inbox.listAll()).length, 0);
    assert.equal(await post(url, "unmatched", event), 200);
    assert.equal((await worker.recover()).processed, 0);
    assert.equal((await inbox.listPending()).length, 1);
    assert.equal((await inbox.listPending())[0]?.notified, false);
  } finally {
    await worker.stop();
    await receiver.close();
    await inbox.close();
  }
});

test("native Pi runtime wakes while idle and defers bus messages behind active work", async t => {
  const pi = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
  if (!pi.ModelRuntime) { t.skip("Set PI_PACKAGE_DIR to installed Pi >=1.1"); return; }
  const require = createRequire(join(packageDir, "package.json"));
  const aiPath = require.resolve.paths("@earendil-works/pi-ai")!
    .map(dir => join(dir, "@earendil-works/pi-ai/dist/compat.js")).find(existsSync);
  assert.ok(aiPath, "installed Pi compatibility API");
  const ai = await import(pathToFileURL(aiPath).href);
  const h = await setup(t, () => { throw new Error("no provider network calls in this test"); });
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(h.dir, "auth.json"), modelsPath: join(h.dir, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "offline-test-key");
  const model = ai.getModel("anthropic", "claude-sonnet-4-5");
  const settingsManager = pi.SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: h.dir, agentDir: join(h.dir, "agent"), settingsManager,
    additionalExtensionPaths: [join(extensionDir, "src/index.ts")],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const manager = pi.SessionManager.inMemory(h.dir);
  const { session } = await pi.createAgentSession({
    cwd: h.dir, agentDir: join(h.dir, "agent"), model, modelRuntime,
    settingsManager, resourceLoader, sessionManager: manager,
  });
  const requests: any[] = [];
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  session.agent.streamFunction = (_model: unknown, context: unknown) => {
    requests.push(structuredClone(context));
    const stream = ai.createAssistantMessageEventStream();
    void (async () => {
      await hold;
      const message = {
        role: "assistant", content: [{ type: "text", text: "Synthetic acknowledgement." }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    })();
    return stream;
  };
  const inbox = new WebhookInbox(join(h.inboxDir, "agent-bus"));
  const receiver = await startWebhookReceiver({ inbox, agentBusSecret: busSecret, port: 0 });
  try {
    await session.bindExtensions({});
    await inbox.register({ resource_id: "agent-bus:alice", kind: "agent-bus", session_id: manager.getSessionId() });
    const url = new URL(AGENT_BUS_PATH, receiver.url).href;
    assert.equal(await post(url, "idle", event), 200);
    await waitFor(() => requests.length === 1 && !session.isStreaming);
    assert.match(JSON.stringify(requests[0]), /Please read the update/);
    hold = new Promise<void>(resolve => { release = resolve; });
    const active = session.prompt("Original user work");
    await waitFor(() => requests.length === 2);
    assert.equal(await post(url, "busy", { ...event, data: { ...event.data, message: { ...event.data.message, id: 2, body: "Queued update." } } }), 200);
    await waitFor(async () => (await inbox.listAll()).find(e => e.webhook_id === "bus:busy")?.notified === true);
    assert.equal(requests.length, 2, "no interruption or parallel model run");
    hold = undefined;
    release!();
    await active;
    await waitFor(() => requests.length === 3 && !session.isStreaming);
    assert.match(JSON.stringify(requests[2]), /Queued update/);
    assert.equal(session.getLastAssistantText(), "Synthetic acknowledgement.");
  } finally {
    release?.();
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    await receiver.close();
    await inbox.close();
  }
});
