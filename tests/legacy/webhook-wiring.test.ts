// Exercises the actual src/index.ts wiring: registration-on-create for
// Task/Group/FindAll/Monitor, the opt-in-only default, and the
// /parallel-webhook command \u2014 through the same registered-tool/command
// surface the model and the user actually use. Complements
// tests/webhook-consumer.test.ts (callback -> fetch -> notify) and
// tests/webhook-inbox.test.ts / tests/webhook-receiver.test.ts (storage and
// HTTP layers) to cover the full create -> registration path.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { WebhookInbox } from "../../src/webhook-inbox.ts";
import { setup } from "../helpers/test-host.ts";

function sessionCtx(base: any, sessionId: string) {
  const notified: { text: string; level: string }[] = [];
  return {
    ctx: {
      ...base,
      sessionManager: { getSessionId: () => sessionId },
      ui: { ...base.ui, notify: (text: string, level = "info") => notified.push({ text, level }) },
    },
    notified,
  };
}

async function taskCreateResponse(run_id: string) {
  return { run_id, status: "queued" as const, is_active: true };
}

test("PIPARA_WEBHOOK_DIR unset (default mode): no registration is written and the command reports inactive", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1/tasks/runs") return new Response(JSON.stringify(await taskCreateResponse("trun_default")), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.ok(!process.env.PIPARA_WEBHOOK_DIR, "must be disabled by default in this harness");
  const { ctx, notified } = sessionCtx(h.ctx, "s-default");
  const result = await h.tools.get("parallel_task")!.execute("id", { action: "create", input: "objective", processor: "lite", webhook_url: "http://127.0.0.1:9/hook", return_mode: "file" }, undefined, () => {}, ctx as any);
  assert.equal((result as any).content[0].text.includes("error"), false);

  await h.commands.get("parallel-webhook")!.handler("status", ctx as any);
  assert.ok(notified.some(n => n.text.includes("opt-in") && n.text.includes("inactive")), JSON.stringify(notified));
});

test("task create registers the returned run_id under the calling session, tied to the actual creation artifact", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1/tasks/runs") return new Response(JSON.stringify(await taskCreateResponse("trun_wired_1")), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const webhookDir = join(h.dir, "webhooks");
  process.env.PIPARA_WEBHOOK_DIR = webhookDir;
  const { ctx } = sessionCtx(h.ctx, "s-task-owner");
  const result: any = await h.tools.get("parallel_task")!.execute("id", { action: "create", input: "objective", processor: "lite", webhook_url: "http://127.0.0.1:9/hook", return_mode: "file" }, undefined, () => {}, ctx as any);
  const artifact = result.details.artifact as string;
  assert.ok(artifact);

  const inbox = new WebhookInbox(webhookDir);
  t.after(() => inbox.close());
  const reg = await inbox.getRegistration("trun_wired_1");
  assert.ok(reg, "run_id from the live response must be registered");
  assert.equal(reg!.kind, "task");
  assert.equal(reg!.session_id, "s-task-owner");
  assert.equal(reg!.webhook_url, "http://127.0.0.1:9/hook");
  assert.equal(reg!.creation_artifact, artifact, "registration is tied to the same receipt artifact the tool returned");
  assert.equal(reg!.status, "pending");
});

test("task create without webhook_url registers nothing (no accidental opt-in)", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1/tasks/runs") return new Response(JSON.stringify(await taskCreateResponse("trun_no_hook")), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const webhookDir = join(h.dir, "webhooks");
  process.env.PIPARA_WEBHOOK_DIR = webhookDir;
  const { ctx } = sessionCtx(h.ctx, "s-no-hook");
  await h.tools.get("parallel_task")!.execute("id", { action: "create", input: "objective", processor: "lite", return_mode: "file" }, undefined, () => {}, ctx as any);

  const inbox = new WebhookInbox(webhookDir);
  t.after(() => inbox.close());
  assert.equal(await inbox.getRegistration("trun_no_hook"), undefined);
});

test("group add registers every returned run_id under the group's caller-specific webhook, without overwriting an explicit per-input webhook", async t => {
  const h = await setup(t, async ({ path, body }) => {
    if (path.endsWith("/runs") && Array.isArray(body?.inputs)) {
      assert.equal(body.inputs[0].webhook.url, "http://127.0.0.1:9/group-hook", "group default applied to an input without its own webhook");
      assert.equal(body.inputs[1].webhook.url, "http://127.0.0.1:9/explicit-hook", "an input's own URL must survive");
      assert.deepEqual(body.inputs[0].webhook.event_types, ["task_run.status"]);
      assert.deepEqual(body.inputs[1].webhook.event_types, ["task_run.status"], "per-input webhooks also need the required subscription");
      assert.equal(body.inputs[2].webhook, null, "explicit opt-out survives the group default");
      return new Response(JSON.stringify({ run_ids: ["trun_g1", "trun_g2", "trun_g3"] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const webhookDir = join(h.dir, "webhooks");
  process.env.PIPARA_WEBHOOK_DIR = webhookDir;
  const { ctx } = sessionCtx(h.ctx, "s-group-owner");
  const inputs = JSON.stringify([
    { input: "a", processor: "lite" },
    { input: "b", processor: "lite", webhook: { url: "http://127.0.0.1:9/explicit-hook" } },
    { input: "c", processor: "lite", webhook: null },
  ]);
  await h.tools.get("parallel_group")!.execute("id", { action: "add", taskgroup_id: "tg_1", inputs, webhook_url: "http://127.0.0.1:9/group-hook", return_mode: "file" }, undefined, () => {}, ctx as any);

  const inbox = new WebhookInbox(webhookDir);
  t.after(() => inbox.close());
  const reg1 = await inbox.getRegistration("trun_g1");
  const reg2 = await inbox.getRegistration("trun_g2");
  assert.equal(reg1?.kind, "task");
  assert.equal(reg1?.session_id, "s-group-owner");
  assert.equal(reg1?.webhook_url, "http://127.0.0.1:9/group-hook");
  // reg2's input carried its own explicit webhook; the local registration
  // must preserve that override, not the group default.
  assert.equal(reg2?.webhook_url, "http://127.0.0.1:9/explicit-hook");
  assert.equal(await inbox.getRegistration("trun_g3"), undefined, "explicit opt-out must not authorize callback processing");
});

test("findall create and monitor create register their returned IDs; /parallel-webhook status reports this session's registrations", async t => {
  const h = await setup(t, async ({ path }) => {
    if (path === "/v1beta/findall/runs") return new Response(JSON.stringify({ findall_id: "fa_wired_1", generator: "core", status: { is_active: true } }), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/v1/monitors") return new Response(JSON.stringify({ monitor_id: "mon_wired_1", type: "event_stream", status: "active", frequency: "1d", processor: "lite", settings: {}, created_at: "2026-01-01T00:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const webhookDir = join(h.dir, "webhooks");
  process.env.PIPARA_WEBHOOK_DIR = webhookDir;
  const { ctx, notified } = sessionCtx(h.ctx, "s-mixed-owner");
  await h.tools.get("parallel_findall")!.execute("id", {
    action: "create", entity_type: "companies", match_conditions: [{ name: "n", description: "d" }],
    objective: "find companies", webhook_url: "http://127.0.0.1:9/fa-hook", return_mode: "file",
  }, undefined, () => {}, ctx as any);
  await h.tools.get("parallel_monitor")!.execute("id", {
    action: "create", type: "event_stream", query: "watch this", frequency: "1d", webhook_url: "http://127.0.0.1:9/mon-hook", return_mode: "file",
  }, undefined, () => {}, ctx as any);

  const inbox = new WebhookInbox(webhookDir);
  t.after(() => inbox.close());
  const faReg = await inbox.getRegistration("fa_wired_1");
  const monReg = await inbox.getRegistration("mon_wired_1");
  assert.equal(faReg?.kind, "findall");
  assert.equal(faReg?.session_id, "s-mixed-owner");
  assert.equal(monReg?.kind, "monitor");
  assert.equal(monReg?.session_id, "s-mixed-owner");

  await h.commands.get("parallel-webhook")!.handler("status", ctx as any);
  const statusMsg = notified.find(n => n.text.includes("registrations total"));
  assert.ok(statusMsg, JSON.stringify(notified));
  assert.ok(statusMsg!.text.includes("2 registrations total"), statusMsg!.text);
  assert.ok(statusMsg!.text.includes("2 owned by this session"), statusMsg!.text);
});

test("group add with a run_ids array too large for the preview budget still registers every id, not just the sampled 3", async t => {
  const COUNT = 1_000; // comfortably exceeds the 8,000-char preview ceiling once serialized
  const bigIds = Array.from({ length: COUNT }, (_, i) => `trun_big_${i}`);
  const h = await setup(t, async ({ path, body }) => {
    if (path.endsWith("/runs") && Array.isArray(body?.inputs)) {
      return new Response(JSON.stringify({ run_ids: bigIds, event_cursor: null, run_cursor: null, status: { is_active: true, num_task_runs: COUNT, modified_at: null, status_message: null, task_run_status_counts: {} } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const webhookDir = join(h.dir, "webhooks");
  process.env.PIPARA_WEBHOOK_DIR = webhookDir;
  const { ctx } = sessionCtx(h.ctx, "s-big-group-owner");
  const inputs = JSON.stringify(Array.from({ length: COUNT }, (_, i) => ({ input: `objective ${i}`, processor: "lite" })));
  const result: any = await h.tools.get("parallel_group")!.execute("id", { action: "add", taskgroup_id: "tg_big", inputs, webhook_url: "http://127.0.0.1:9/big-hook", return_mode: "file", preview_chars: 8000 }, undefined, () => {}, ctx as any);
  // The receipt itself stays bounded (this is the whole point of the
  // preview ceiling); only the local registration step reads the complete
  // artifact for run_ids.
  assert.ok(result.content[0].text.length <= 8_000);
  assert.equal(JSON.parse(result.content[0].text).control.run_ids.length, 3);

  const inbox = new WebhookInbox(webhookDir);
  t.after(() => inbox.close());
  const registrations = await inbox.listRegistrations();
  assert.equal(registrations.length, COUNT, `expected all ${COUNT} run_ids registered, got ${registrations.length}`);
  assert.ok(await inbox.getRegistration(bigIds[0]!));
  assert.ok(await inbox.getRegistration(bigIds[COUNT - 1]!), "the last id (never present in a 3-item sample) must still be registered");
});

test("task create with wait_seconds>0: a post-create wait failure still registers the run_id from the retained creation_artifact, without recreating", async t => {
  let resultCalls = 0;
  const h = await setup(t, async ({ path, method }) => {
    if (path === "/v1/tasks/runs" && method === "POST") {
      return new Response(JSON.stringify({ run_id: "trun_wait_fail", status: "queued", is_active: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/tasks/runs/trun_wait_fail/result") {
      resultCalls++;
      return new Response(JSON.stringify({ message: "internal error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/tasks/runs/trun_wait_fail" && method === "GET") {
      return new Response(JSON.stringify({ run_id: "trun_wait_fail", status: "running", is_active: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const webhookDir = join(h.dir, "webhooks");
  process.env.PIPARA_WEBHOOK_DIR = webhookDir;
  const { ctx } = sessionCtx(h.ctx, "s-wait-fail-owner");
  await assert.rejects(
    h.tools.get("parallel_task")!.execute("id", { action: "create", input: "objective", processor: "lite", wait_seconds: 1, webhook_url: "http://127.0.0.1:9/hook", return_mode: "file" }, undefined, () => {}, ctx as any),
  );
  assert.equal(resultCalls, 1, "a failed wait must never recreate/re-fetch beyond the one result attempt");

  const inbox = new WebhookInbox(webhookDir);
  t.after(() => inbox.close());
  const reg = await inbox.getRegistration("trun_wait_fail");
  assert.ok(reg, "the run_id from the successful creation must still be registered despite the later wait failure");
  assert.equal(reg!.session_id, "s-wait-fail-owner");
  assert.equal(reg!.webhook_url, "http://127.0.0.1:9/hook");
  assert.ok(reg!.creation_artifact, "must be tied to the retained creation artifact, not a recreated one");
  const creation = JSON.parse(await readFile(reg!.creation_artifact!, "utf8"));
  assert.equal(creation.run_id, "trun_wait_fail");
  assert.equal(creation.status, "queued", "must retain the actual creation receipt, not the later failure artifact");
});
