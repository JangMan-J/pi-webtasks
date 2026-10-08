import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "../helpers/test-host.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (err) { return JSON.parse((err as Error).message); }
  assert.fail("expected the tool to fail");
}

test("a rejected request says nothing was created and names the fix", async t => {
  const h = await setup(t, () => json({ type: "error", error: { message: "Requests with an app API key must include a memory_scope_key." } }, 403));
  const receipt = await failure(h.tools.get("parallel_memory")!.execute("x", { action: "retrieve" }, undefined, undefined, h.ctx));
  assert.match(receipt.notice, /^Request failed: Requests with an app API key must include a memory_scope_key\./);
  assert.match(receipt.notice, /Nothing was created\. Fix the arguments/);
  assert.doesNotMatch(receipt.notice, /never repeat/);
});

test("local validation failures report the received value and allow a fixed retry", async t => {
  const h = await setup(t, () => { throw new Error("no request expected"); });
  const receipt = await failure(h.tools.get("parallel_findall")!.execute("x", { action: "entity_search", objective: "AI labs", entity_type: "company" }, undefined, undefined, h.ctx));
  assert.match(receipt.notice, /entity_type "people" or "companies" \(received "company"\)/);
  assert.match(receipt.notice, /Nothing was created/);
  assert.equal(h.calls.length, 0);
});

test("a failure after creation says not to recreate the run", async t => {
  const h = await setup(t, ({ path, method }) => {
    if (path === "/v1/tasks/runs" && method === "POST") return json({ run_id: "trun_made", status: "queued", is_active: true });
    if (path.endsWith("/result")) return json({ message: "internal error" }, 500);
    return json({ run_id: "trun_made", status: "running", is_active: true });
  });
  const receipt = await failure(h.tools.get("parallel_task")!.execute("x", { action: "create", input: "q", processor: "lite", wait_seconds: 1 }, undefined, undefined, h.ctx));
  assert.match(receipt.notice, /The resource already exists\. Do not create it again/);
  assert.equal(h.calls.filter(c => c.method === "POST" && c.path === "/v1/tasks/runs").length, 1);
});

test("timeouts are reported as uncertain rather than safe to retry", async t => {
  const h = await setup(t, () => json({ message: "server busy" }, 503));
  const receipt = await failure(h.tools.get("parallel_search")!.execute("x", { search_queries: ["test query here"] }, undefined, undefined, h.ctx));
  assert.match(receipt.notice, /Completion is uncertain/);
});

test("Task guidance states that runs cannot be cancelled", async t => {
  const h = await setup(t, () => json({}));
  assert.match(h.tools.get("parallel_task")!.description, /cannot cancel Task runs/);
  assert.match(h.tools.get("parallel_findall")!.promptGuidelines.join(" "), /entity_type "people" or "companies"/);
});
