import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { WebhookInbox } from "../../src/webhook-inbox.ts";
import { checkResult, setup } from "../helpers/test-host.ts";

const URL = "https://callbacks.example.test/parallel-webhook";
const FINDALL_EVENTS = ["findall.run.completed", "findall.run.cancelled", "findall.run.failed"];
const MONITOR_EVENTS = ["monitor.event.detected", "monitor.execution.completed", "monitor.execution.failed"];
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

function caller(h: Awaited<ReturnType<typeof setup>>) {
  const ctx = { ...h.ctx, sessionManager: { getSessionId: () => "config-owner" } };
  return async (name: string, args: Record<string, unknown>) => {
    const result = await h.tools.get(`parallel_${name}`)!.execute("config", { return_mode: "file", ...args }, undefined, undefined, ctx);
    return checkResult(result).receipt;
  };
}

test("configured callbacks apply to FindAll, Monitor and Group creation with required events", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1beta/findall/runs") return json({ findall_id: "fa_config", status: { is_active: true } });
    if (path === "/v1/monitors") return json({ monitor_id: "mon_config", status: "active" });
    if (path === "/v1/tasks/groups/tg_config/runs") return json({ run_ids: ["tr_config"] });
    throw new Error(`Unexpected request ${path}`);
  });
  process.env.PIPARA_WEBHOOK_DIR = join(h.dir, "inbox");
  process.env.PIPARA_WEBHOOK_URL = URL;
  const call = caller(h);
  await call("findall", { action: "create", entity_type: "companies", match_conditions: [{ name: "n", description: "d" }] });
  await call("monitor", { action: "create", query: "watch", frequency: "1d" });
  await call("group", { action: "add", taskgroup_id: "tg_config", inputs: JSON.stringify([{ input: "question", processor: "lite" }]) });
  assert.deepEqual(h.calls[0].body.webhook, { url: URL, event_types: FINDALL_EVENTS });
  assert.deepEqual(h.calls[1].body.webhook, { url: URL, event_types: MONITOR_EVENTS });
  assert.deepEqual(h.calls[2].body.inputs[0].webhook, { url: URL, event_types: ["task_run.status"] });
  assert.ok(h.calls.every(c => !c.beta?.includes("webhook-2025-08-12")));
  const inbox = new WebhookInbox(process.env.PIPARA_WEBHOOK_DIR);
  t.after(() => inbox.close());
  assert.equal((await inbox.listRegistrations()).length, 3);
});

test("explicit URL/events override defaults, null disables, and Monitor updates do not apply creation defaults", async t => {
  let created = 0;
  const h = await setup(t, async ({ path }) => json(path === "/v1/tasks/runs" ? { run_id: `tr_override_${++created}` } : { monitor_id: "mon_existing" }));
  process.env.PIPARA_WEBHOOK_DIR = join(h.dir, "inbox");
  process.env.PIPARA_WEBHOOK_URL = URL;
  const call = caller(h);
  const explicit = "https://elsewhere.example.test/hook";
  await call("task", { action: "create", processor: "lite", input: "question", webhook_url: explicit });
  assert.deepEqual(h.calls.at(-1)!.body.webhook, { url: explicit, event_types: ["task_run.status"] });
  const disabled = await call("task", { action: "create", processor: "lite", input: "question", webhook_url: null });
  assert.equal(h.calls.at(-1)!.body.webhook, undefined);
  assert.equal(disabled.webhook, undefined);
  const inbox = new WebhookInbox(process.env.PIPARA_WEBHOOK_DIR);
  t.after(() => inbox.close());
  assert.equal(await inbox.getRegistration("tr_override_2"), undefined);
  await call("monitor", { action: "update", monitor_id: "mon_existing", frequency: "2d" });
  assert.equal(h.calls.at(-1)!.body.webhook, undefined);
  await call("monitor", { action: "update", monitor_id: "mon_existing", webhook_url: explicit });
  assert.deepEqual(h.calls.at(-1)!.body.webhook, { url: explicit, event_types: MONITOR_EVENTS });
  await call("monitor", { action: "update", monitor_id: "mon_existing", webhook_url: explicit, webhook_events: ["monitor.event.detected"] });
  assert.deepEqual(h.calls.at(-1)!.body.webhook.event_types, ["monitor.event.detected"]);
  await call("monitor", { action: "update", monitor_id: "mon_existing", webhook_url: null });
  assert.equal(h.calls.at(-1)!.body.webhook, null);
  for (const name of ["task", "group", "findall", "monitor"]) {
    const schema = h.tools.get(`parallel_${name}`)!.parameters.properties.webhook_url;
    assert.ok(schema.anyOf.some((variant: { type: string }) => variant.type === "null"), `${name} schema must allow opt-out`);
  }
});

test("invalid callback configuration fails before creating research", async t => {
  const h = await setup(t, async () => { throw new Error("No API calls expected"); });
  process.env.PIPARA_WEBHOOK_URL = URL;
  const call = caller(h);
  const args = { action: "create", input: "question", processor: "lite" };
  await assert.rejects(call("task", args), /PIPARA_WEBHOOK_DIR/);
  process.env.PIPARA_WEBHOOK_DIR = join(h.dir, "inbox");
  for (const webhook_url of ["file:///tmp/callback", "https://user:password@example.test/hook", ""]) {
    await assert.rejects(call("task", { ...args, webhook_url }), /webhook_url/);
  }
  await assert.rejects(call("task", { ...args, webhook_events: [] }), /webhook_events/);
  assert.equal(h.calls.length, 0);
});
