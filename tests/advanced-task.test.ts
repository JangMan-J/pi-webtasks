import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import { setup } from "./helpers/test-host.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await delay(10);
  assert.ok(check(), "expected notification or request");
}

test("advanced Task options preserve intent-first tracking, structured results, and owning-session stream delivery", async t => {
  let db: WebhookInbox;
  let metadata: any;
  let resultFetches = 0;
  const h = await setup(t, async call => {
    if (call.path === "/v1/tasks/groups") return json({ taskgroup_id: "tg_sdk" });
    if (call.method === "POST" && call.path.endsWith("/runs")) {
      metadata = call.body.inputs[0].metadata;
      const intent = await db.getResearch(metadata.webtasks_ref);
      assert.equal(intent!.status, "dispatching", "intent precedes the remote side effect");
      assert.equal(intent!.session_id, "session-a");
      assert.equal(intent!.group_id, "tg_sdk");
      assert.equal(intent!.effort, "custom", "an unknown processor must not receive a low-tier estimate");
      return json({ run_ids: ["run_sdk"], event_cursor: "before" });
    }
    if (call.path.endsWith("/events")) {
      assert.equal(call.query.get("last_event_id"), "before");
      return sse([{ type: "task_run.state", event_id: "completed", run: { run_id: "run_sdk", status: "completed", metadata } }]);
    }
    if (call.path.endsWith("/runs")) return sse([]);
    if (call.path === "/v1/tasks/runs/run_sdk/result") {
      resultFetches++;
      return json({ run: { run_id: "run_sdk", status: "completed" }, output: {
        type: "json", content: { name: "Example", founded: 2020 },
        basis: [{ field: "founded", citations: [{ title: "Source", url: "https://example.org/about" }] }],
      } });
    }
    throw new Error(`Unexpected ${call.method} ${call.path}`);
  }, { webhookUrl: "https://callbacks.example.test/tasks" });
  db = new WebhookInbox(h.inboxDir);
  t.after(() => db.close());
  await h.start();
  const stranger = await h.instance("session-b");
  await stranger.start();
  const task = {
    input: { company: "Example" }, processor: "ultra",
    task_spec: { output_schema: { type: "json", json_schema: {
      type: "object", properties: { name: { type: "string" }, founded: { type: "integer" } }, required: ["name", "founded"],
    } } },
    source_policy: { include_domains: ["example.org"], exclude_domains: ["invalid.example"], after_date: "2020-01-01" },
    advanced_settings: { location: "US" }, enable_events: true,
    mcp_servers: [{ name: "reference", url: "https://mcp.example.test", allowed_tools: ["lookup"] }],
    memory_scope_key: "test-scope", previous_interaction_id: "interaction_parent", metadata: { project: "test" },
  };
  const submitted = await h.call("webtasks_submit", { label: "Company facts", task, betas: ["mcp-server-2025-07-17"] });
  const reference = submitted.details.research;
  assert.match(reference, /^research_[0-9a-f-]{36}$/);
  const post = h.calls.find(c => c.method === "POST" && c.path.endsWith("/runs"))!;
  const { metadata: sentMetadata, webhook, ...sentTask } = post.body.inputs[0];
  const { metadata: userMetadata, ...nativeTask } = task;
  assert.deepEqual(sentTask, nativeTask);
  assert.deepEqual(sentMetadata, { ...userMetadata, webtasks_ref: reference, webtasks_session: "session-a", webtasks_group: "tg_sdk" });
  assert.deepEqual(webhook, { url: "https://callbacks.example.test/tasks", event_types: ["task_run.status"] });
  assert.equal(post.body.default_task_spec, undefined, "no implicit text schema replaces SDK output");
  assert.equal(post.beta, "mcp-server-2025-07-17");

  await waitFor(() => h.sent.length === 1);
  assert.equal(stranger.sent.length, 0);
  const message = h.sent[0].message as any;
  assert.equal(message.details.reference, reference);
  assert.equal(message.details.status, "completed");
  assert.deepEqual(JSON.parse(await readFile(message.details.artifact, "utf8")).output.content, { name: "Example", founded: 2020 });
  const read = await h.call("deep_search", { research: reference });
  assert.match(read.text, /"founded": 2020/);
  assert.match(read.text, /https:\/\/example.org\/about/);
  assert.equal(resultFetches, 1);
});

test("advanced validation rejects ownership overrides and malformed native inputs before group creation", async t => {
  const h = await setup(t, () => { throw new Error("No network expected"); });
  await h.start();
  const good = { input: "Question", processor: "core" };
  for (const args of [
    { label: "  ", task: good },
    { label: "Task", task: { ...good, input: [] } },
    { label: "Task", task: { ...good, processor: "" } },
    { label: "Task", task: { ...good, webhook: null } },
    { label: "Task", task: { ...good, metadata: { webtasks_ref: "foreign" } } },
    { label: "Task", task: { ...good, metadata: { webtasks_new: "foreign" } } },
    { label: "Task", task: { ...good, group_id: "foreign" } },
    { label: "Task", task: { ...good, task_spec: {} } },
    { label: "Task", task: good, betas: ["bad\nheader"] },
    { label: "Task", task: { ...good, source_policy: { include_domains: Array(101).fill("a.test"), exclude_domains: Array(100).fill("b.test") } } },
  ]) await assert.rejects(h.run("webtasks_submit", args));
  assert.equal(h.calls.length, 0);
});

test("uncertain SDK submission is recovered from metadata after restart without another submission", async t => {
  let metadata: any;
  let recover = false;
  const h = await setup(t, call => {
    if (call.path === "/v1/tasks/groups") return json({ taskgroup_id: "tg_sdk" });
    if (call.method === "POST" && call.path.endsWith("/runs")) {
      metadata = call.body.inputs[0].metadata;
      return json({ error: "gateway lost the acceptance response" }, 502);
    }
    if (call.path.endsWith("/events")) return sse([]);
    if (call.path.endsWith("/runs")) return sse(recover ? [{
      type: "task_run.state", run: { run_id: "run_uncertain", status: "completed", metadata },
    }] : []);
    if (call.path.endsWith("/result")) return json({ run: { run_id: "run_uncertain", status: "completed" }, output: { content: "Recovered", basis: [] } });
    throw new Error(`Unexpected ${call.method} ${call.path}`);
  });
  await h.start();
  const err = await h.run("webtasks_submit", { label: "Recover me", task: { input: "Question", processor: "core" } }).catch((e: Error) => e);
  assert.match(err.message, /uncertain; do not resubmit/);
  const reference = /research_[0-9a-f-]{36}/.exec(err.message)![0];
  const db = new WebhookInbox(h.inboxDir);
  t.after(() => db.close());
  assert.equal((await db.getResearch(reference))!.status, "uncertain");
  await h.stop();
  recover = true;
  const reloaded = await h.instance();
  await reloaded.start();
  await waitFor(() => reloaded.sent.length === 1);
  assert.equal(reloaded.sent[0].message.details.reference, reference);
  assert.equal((await db.getResearch(reference))!.run_id, "run_uncertain");
  assert.equal((await db.getResearch(reference))!.status, "completed");
  assert.equal(h.calls.filter(c => c.method === "POST" && c.path.endsWith("/runs")).length, 1, "no paid retry or resubmission");
});

test("cancelling a SDK call preserves its uncertain reference and aborts the request", async t => {
  const h = await setup(t, call => {
    if (call.path === "/v1/tasks/groups") return json({ taskgroup_id: "tg_sdk" });
    if (call.method === "POST" && call.path.endsWith("/runs")) return new Promise<Response>((_, reject) =>
      call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    return sse([]);
  });
  await h.start();
  const abort = new AbortController();
  const pending = h.run("webtasks_submit", { label: "Cancel wait", task: { input: "Question", processor: "pro" } }, abort.signal).catch((e: Error) => e);
  await waitFor(() => h.calls.some(c => c.method === "POST" && c.path.endsWith("/runs")));
  abort.abort();
  const err = await pending;
  assert.match(err.message, /uncertain; do not resubmit/);
  const db = new WebhookInbox(h.inboxDir);
  t.after(() => db.close());
  const reference = /research_[0-9a-f-]{36}/.exec(err.message)![0];
  assert.equal((await db.getResearch(reference))!.status, "uncertain");
  assert.equal(h.calls.filter(c => c.method === "POST" && c.path.endsWith("/runs")).length, 1);
});
