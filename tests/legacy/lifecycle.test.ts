import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setup } from "../helpers/test-host.ts";
import { PREVIEW_LIMIT } from "../../src/results.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "retry-after-ms": "1" },
});
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {
  headers: { "Content-Type": "text/event-stream" },
});
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const conditions = [{ name: "software", description: "Makes software" }];
const snapshot = (status = "running", active = true) => ({
  run: { findall_id: "findall-test", status: { status, is_active: active } }, candidates: [],
});
const created = { run_id: "created-task", status: "running" };
const response = {
  id: "response-test", status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "Cited answer", annotations: [{ type: "url_citation", url: "https://example.com/source" }] }] }],
};
const responseStart = { type: "response.created", response: { id: response.id, status: "in_progress" } };
async function failed(promise: Promise<unknown>) {
  let receipt: any;
  await assert.rejects(promise, err => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.length <= PREVIEW_LIMIT);
    receipt = JSON.parse(err.message);
    return true;
  });
  const data = receipt.artifact ? JSON.parse(await readFile(receipt.artifact, "utf8")) : undefined;
  return { receipt, data };
}

test("FindAll waits for completion in one tool call", async t => {
  let count = 0;
  const h = await setup(t, () => json(++count === 1 ? snapshot() : snapshot("completed", false)));
  const receipt = await h.execute("findall", { action: "result", findall_id: "findall-test", wait_seconds: 2 });
  assert.equal(receipt.control["run.status.status"], "completed");
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.method === "GET" && c.path.endsWith("/findall-test/result")));
});

test("FindAll deadline returns the latest snapshot and ID without another request", async t => {
  const h = await setup(t, () => json(snapshot()));
  const start = performance.now();
  const receipt = await h.execute("findall", { action: "result", findall_id: "findall-test", wait_seconds: 0.03 });
  assert.equal(receipt.control.timeout, true);
  assert.equal(receipt.control.findall_id, "findall-test");
  assert.equal(receipt.control["run.status.is_active"], true);
  assert.equal(h.calls.length, 1);
  assert.ok(performance.now() - start < 1000);
});

test("FindAll exits for action-required, terminal and inactive states, or snapshot mode", async t => {
  let data = snapshot();
  const h = await setup(t, () => json(data));
  for (const [status, active] of [["action_required", true], ["failed", false], ["cancelled", false], ["completed", false], ["running", false]] as const) {
    data = snapshot(status, active);
    const before = h.calls.length;
    const receipt = await h.execute("findall", { action: "result", findall_id: "findall-test", wait_seconds: 20 });
    assert.equal(receipt.control["run.status.status"], status);
    assert.equal(receipt.control.timeout, undefined);
    assert.equal(h.calls.length, before + 1);
  }
  data = snapshot();
  const before = h.calls.length;
  await h.execute("findall", { action: "result", findall_id: "findall-test", wait_seconds: 0 });
  assert.equal(h.calls.length, before + 1);
});

test("FindAll cancellation preserves the snapshot and stops polling", async t => {
  const controller = new AbortController();
  const h = await setup(t, () => json(snapshot()));
  const failure = await failed(h.execute("findall", { action: "result", findall_id: "findall-test", wait_seconds: 10 }, controller.signal, () => controller.abort()));
  assert.equal(failure.receipt.control.findall_id, "findall-test");
  assert.equal(failure.data.run.findall_id, "findall-test");
  assert.equal(failure.data.partial, true);
  assert.equal(h.calls.length, 1);
});

test("FindAll deadline also aborts an in-flight HTTP request", async t => {
  let aborted = false;
  const h = await setup(t, call => new Promise((_resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("deadline did not abort fetch")), 500);
    const abort = () => {
      clearTimeout(guard);
      aborted = true;
      reject(call.signal.reason);
    };
    call.signal.addEventListener("abort", abort, { once: true });
    if (call.signal.aborted) abort();
  }));
  const receipt = await h.execute("findall", { action: "result", findall_id: "findall-test", wait_seconds: 0.25 });
  assert.equal(aborted, true, JSON.stringify(h.calls.map(call => ({ path: call.path, aborted: call.signal.aborted }))));
  assert.equal(receipt.control.timeout, true);
  assert.equal(receipt.control.findall_id, "findall-test");
  assert.match(JSON.stringify(receipt.diagnostics?.error ?? null), /before the first snapshot/);
  const saved = JSON.parse(await readFile(receipt.artifact, "utf8"));
  assert.equal(saved.run, undefined, "Do not invent a snapshot when the request never completed");
  assert.ok(saved.error.cause);
  assert.equal(h.calls.length, 1);
});

test("Task, Group and FindAll share JSON schema conversion without changing advanced TaskSpec", async t => {
  const h = await setup(t, () => json(created));
  for (const output_schema of [schema, JSON.stringify(schema), { type: "json", json_schema: schema }]) {
    await h.execute("task", { action: "create", input: "test", processor: "lite", output_schema });
    assert.deepEqual(h.calls.at(-1)!.body.task_spec, { output_schema: { type: "json", json_schema: schema } });
    await h.execute("group", { action: "add", taskgroup_id: "group", inputs: '[{"input":"test","processor":"lite"}]', output_schema });
    assert.deepEqual(h.calls.at(-1)!.body.default_task_spec, { output_schema: { type: "json", json_schema: schema } });
    await h.execute("findall", { action: "enrich", findall_id: "findall-test", output_schema });
    assert.deepEqual(h.calls.at(-1)!.body.output_schema, { type: "json", json_schema: schema });
  }
  for (const task_spec of [{ output_schema: { type: "text", description: "A paragraph" } }, { output_schema: { type: "auto" } }]) {
    await h.execute("task", { action: "create", input: "test", processor: "lite", task_spec: JSON.stringify(task_spec) });
    assert.deepEqual(h.calls.at(-1)!.body.task_spec, task_spec);
  }
  const before = h.calls.length;
  for (const output_schema of [[], "[]", "null", "false"]) {
    await failed(h.execute("task", { action: "create", input: "test", processor: "lite", output_schema }));
  }
  const conflict = await failed(h.execute("task", { action: "create", input: "test", processor: "lite", output_schema: schema, task_spec: '{}' }));
  assert.match(JSON.stringify(conflict.data), /not both/);
  assert.equal(h.calls.length, before);
});

test("FindAll conditions are typed and ingest cannot change the default or explicit generator", async t => {
  const h = await setup(t, call => json(call.path.endsWith("/ingest") ? { entity_type: "companies", match_conditions: conditions, generator: "pro" } : { findall_id: "findall-test" }));
  const field = h.tools.get("parallel_findall").parameters.properties.match_conditions;
  assert.ok(field.anyOf.some((s: any) => s.type === "array" && s.items.required.includes("name") && s.items.required.includes("description")));
  for (const [action, generator, expected] of [["create", undefined, "core"], ["preview", undefined, "preview"], ["create", "base", "base"], ["preview", "pro", "pro"]]) {
    await h.execute("findall", { action, objective: "test", generator });
    assert.equal(h.calls.at(-1)!.body.generator, expected);
  }
  for (const match_conditions of [conditions, JSON.stringify(conditions)]) {
    await h.execute("findall", { action: "create", objective: "test", entity_type: "companies", match_conditions });
    assert.deepEqual(h.calls.at(-1)!.body.match_conditions, conditions);
  }
  const before = h.calls.length;
  await failed(h.execute("findall", { action: "create", objective: "test", entity_type: "companies", match_conditions: [{ name: "missing description" }] }));
  assert.equal(h.calls.length, before);
});

test("nested 422 diagnostics expose bounded field paths without echoing request input", async t => {
  const errors = Array.from({ length: 30 }, (_, i) => ({
    loc: ["body", "task_spec", "output_schema", "JsonSchema", "json_schema", i], msg: "Field required", type: "missing", input: "private-input",
  }));
  const h = await setup(t, () => json({ type: "error", error: { message: "Request validation error.", detail: { errors } } }, 422));
  const { receipt, data } = await failed(h.execute("task", { action: "create", input: "test", processor: "lite", task_spec: '{}' }));
  const diagnostics = receipt.diagnostics.error.validation_errors;
  assert.ok(diagnostics.length > 0 && diagnostics.length <= 5);
  assert.deepEqual(diagnostics[0], { loc: errors[0].loc, msg: "Field required", type: "missing" });
  assert.equal(JSON.stringify(receipt).includes("private-input"), false);
  assert.equal(data.error.error.error.detail.errors.length, 30);
});

test("paid submissions never retry an ambiguous HTTP 500", async t => {
  const h = await setup(t, () => json({ message: "ambiguous failure" }, 500));
  const cases: [string, any][] = [
    ["search", { search_queries: ["test search"] }], ["extract", { urls: ["https://example.com"] }],
    ["responses", { input: "test" }], ["responses", { input: "test", stream: true }],
    ["task", { action: "create", input: "test", processor: "lite" }],
    ["group", { action: "create" }], ["group", { action: "add", taskgroup_id: "group", inputs: '[{"input":"test","processor":"lite"}]' }],
    ["findall", { action: "create", entity_type: "companies", match_conditions: conditions }],
    ["findall", { action: "preview", entity_type: "companies", match_conditions: conditions }],
    ["findall", { action: "entity_search", objective: "test", entity_type: "people" }],
    ["findall", { action: "extend", findall_id: "findall-test", additional_match_limit: 1 }],
    ["findall", { action: "enrich", findall_id: "findall-test", output_schema: schema }],
    ["monitor", { action: "create", query: "test", frequency: "1d" }], ["monitor", { action: "trigger", monitor_id: "monitor" }],
  ];
  for (const [name, args] of cases) {
    const before = h.calls.length;
    await failed(h.execute(name, args));
    assert.equal(h.calls.length - before, 1, `${name}.${args.action ?? "call"}`);
  }
});

test("read-only status calls retain SDK retries", async t => {
  let count = 0;
  const h = await setup(t, () => ++count === 1 ? json({ message: "temporary read failure" }, 500) : json(created));
  const receipt = await h.execute("task", { action: "status", run_id: created.run_id });
  assert.equal(receipt.control.run_id, created.run_id);
  assert.equal(h.calls.length, 2);
});

test("Task creation receipt exists before waiting and survives both follow-up failures", async t => {
  let persistedBeforeWait: any[] = [];
  const h = await setup(t, async call => {
    if (call.method === "POST") return json(created);
    if (call.path.endsWith("/result")) {
      const files = await readdir(h.artifacts).catch(() => []);
      persistedBeforeWait = await Promise.all(files.map(async file => JSON.parse(await readFile(join(h.artifacts, file), "utf8"))));
      return json({ message: "result not ready" }, 400);
    }
    return json({ message: "status forbidden" }, 403);
  });
  const { receipt, data } = await failed(h.execute("task", { action: "create", input: "test", processor: "lite", wait_seconds: 1 }));
  assert.ok(persistedBeforeWait.some(x => x.run_id === created.run_id));
  assert.equal(receipt.control.run_id, created.run_id);
  assert.equal(data.run_id, created.run_id);
  assert.equal(data.partial, true);
  assert.match(JSON.stringify(data), /result not ready/);
  assert.match(JSON.stringify(data), /status forbidden/);
  const creation = JSON.parse(await readFile(receipt.control.creation_artifact, "utf8"));
  assert.equal(creation.run_id, created.run_id);
  assert.equal((await stat(receipt.control.creation_artifact)).mode & 0o777, 0o600);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
});

test("Task wait timeout retains the creation receipt and final output_path remains exclusive", async t => {
  let complete = false;
  const h = await setup(t, call => call.path.endsWith("/result")
    ? complete ? json({ run: { ...created, status: "completed" }, output: { content: "answer", basis: [] } }) : json({ message: "result not ready" }, 400)
    : json(created));
  const args = { action: "create", input: "test", processor: "lite", wait_seconds: 1, output_path: "final.json" };
  const waiting = await h.execute("task", args);
  assert.equal(waiting.control.timeout, true);
  assert.equal(waiting.control.run_id, created.run_id);
  assert.equal(waiting.artifact, join(h.dir, "final.json"));
  assert.notEqual(waiting.control.creation_artifact, waiting.artifact);
  complete = true;
  const final = await h.execute("task", { ...args, output_path: "completed.json" });
  assert.equal(final.control["run.status"], "completed");
  assert.ok(final.control.creation_artifact);
  const failedSave = await failed(h.execute("task", args));
  assert.equal(failedSave.receipt.control.run_id, created.run_id);
  assert.ok(failedSave.receipt.control.creation_artifact);
  assert.equal(JSON.parse(await readFile(waiting.artifact, "utf8")).timeout, true);
});

test("late Task cancellation preserves the decoded answer and creation receipt", async t => {
  let controller = new AbortController();
  const completed = { run: { ...created, status: "completed" }, output: { content: "Completed paid answer", basis: [] } };
  const h = await setup(t, call => {
    if (call.method === "POST") return json(created);
    assert.ok(call.path.endsWith("/result"), "Late cancellation must not fetch status again");
    const response = json(completed);
    const parse = response.json.bind(response);
    response.json = async () => {
      const data = await parse();
      controller.abort(new Error("cancel after result decode"));
      return data;
    };
    return response;
  });
  for (const action of ["result", "create"]) {
    controller = new AbortController();
    const before = h.calls.length;
    const { receipt, data } = await failed(h.execute("task", {
      action, input: "test", processor: "lite", run_id: created.run_id, wait_seconds: 1,
    }, controller.signal));
    assert.equal(data.partial, true, "Cancellation remains an error, not a successful tool result");
    assert.equal(data.run_id, created.run_id);
    assert.deepEqual(data.output, completed.output);
    assert.equal(data.run.status, "completed");
    assert.equal(h.calls.length - before, action === "create" ? 2 : 1);
    if (action === "create") {
      const creation = JSON.parse(await readFile(receipt.control.creation_artifact, "utf8"));
      assert.equal(creation.run_id, created.run_id);
    }
  }
});

test("Task cancellation after creation preserves the ID without a status request", async t => {
  const controller = new AbortController();
  const h = await setup(t, call => {
    if (call.method === "POST") return json(created);
    controller.abort();
    throw new Error("cancelled during result");
  });
  const { receipt, data } = await failed(h.execute("task", { action: "create", input: "test", processor: "lite", wait_seconds: 10 }, controller.signal));
  assert.equal(receipt.control.run_id, created.run_id);
  assert.equal(data.partial, true);
  assert.ok(receipt.control.creation_artifact);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(h.calls.filter(c => c.path === `/v1/tasks/runs/${created.run_id}`).length, 0);
});

test("Task result errors other than timeouts remain errors with the original ID", async t => {
  const h = await setup(t, call => call.path.endsWith("/result") ? json({ message: "forbidden" }, 403) : json(created));
  const { receipt, data } = await failed(h.execute("task", { action: "result", run_id: created.run_id, wait_seconds: 1 }));
  assert.equal(receipt.control.run_id, created.run_id);
  assert.equal(data.partial, true);
  assert.equal(data.timeout, undefined);
  assert.equal(h.calls.length, 2);
});

test("Responses consumes more than 200 events and retains the completed answer and citations", async t => {
  const events = [responseStart, ...Array.from({ length: 210 }, () => ({ type: "response.output_text.delta", delta: "x" })), { type: "response.completed", response }];
  const h = await setup(t, () => sse(events));
  const receipt = await h.execute("responses", { input: "test", stream: true, previous_response_id: "prior" });
  const saved = JSON.parse(await readFile(receipt.artifact, "utf8"));
  assert.equal(saved.events.length, events.length);
  assert.deepEqual(saved.response, response);
  assert.equal(saved.output_text, "Cited answer");
  assert.equal(receipt.control["response.status"], "completed");
  assert.match(JSON.stringify(receipt.preview), /https:\/\/example.com\/source/);
  assert.equal(h.calls.at(-1)!.body.previous_response_id, "prior");
});

test("Responses EOF, terminal failure, interruption and cancellation preserve partial output and ID", async t => {
  let events: any[] = [];
  let interrupt = false;
  const h = await setup(t, () => {
    if (!interrupt) return sse(events);
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) { controller.error(new Error("connection interrupted")); return; }
        sent = true;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(responseStart)}\n\n`));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  for (const terminal of [undefined, "response.failed", "response.incomplete", "error"]) {
    events = [responseStart, { type: "response.output_text.delta", delta: "partial text" }];
    if (terminal) events.push({ type: terminal, response: { id: response.id, status: "failed", error: { message: "test failure" } } });
    const { receipt, data } = await failed(h.execute("responses", { input: "test", stream: true }));
    assert.equal(data.partial, true);
    assert.equal(data.response.id, response.id);
    assert.equal(data.events.length, events.length);
    assert.equal(receipt.control.partial, true);
    assert.ok(receipt.diagnostics.error);
  }
  events = [responseStart, { type: "response.completed", response }];
  const controller = new AbortController();
  const failure = await failed(h.execute("responses", { input: "test", stream: true }, controller.signal, () => controller.abort()));
  assert.equal(failure.data.response.id, response.id);
  assert.equal(failure.data.partial, true);
  interrupt = true;
  const disconnected = await failed(h.execute("responses", { input: "test", stream: true }));
  assert.equal(disconnected.data.response.id, response.id);
  assert.equal(disconnected.data.events.length, 1);
  assert.match(JSON.stringify(disconnected.data.error), /connection interrupted/);
  interrupt = false;
  events = [responseStart, { type: "response.completed", response: { ...response, output: [] } }];
  const empty = await failed(h.execute("responses", { input: "test", stream: true }));
  assert.equal(empty.data.partial, true);
});

test("empty Responses answers retain their receipt mode and save one redacted artifact", async t => {
  const h = await setup(t, () => json({ id: "empty-response", output: [], api_key: "response-secret" }));
  for (const return_mode of [undefined, "preview", "file"] as const) {
    const { receipt, data } = await failed(h.execute("responses", { input: "test", return_mode }));
    assert.equal(receipt.return_mode, return_mode ?? "preview");
    assert.equal("preview" in receipt, return_mode !== "file");
    assert.equal(receipt.control["response.id"], "empty-response");
    assert.match(data.error, /empty Responses answer/);
    assert.equal(data.response.api_key, "[redacted]");
    assert.equal(JSON.stringify(receipt).includes("response-secret"), false);
  }
  assert.equal(h.calls.length, 3);
  assert.equal((await readdir(h.artifacts)).length, 3, "One artifact per failed answer, not a second error artifact");
});

test("Responses filters use the supported nested web_search contract in JSON and SSE", async t => {
  const h = await setup(t, call => call.body.stream ? sse([{ type: "response.completed", response }]) : json(response));
  const properties = h.tools.get("parallel_responses").parameters.properties;
  for (const field of ["allowed_domains", "blocked_domains"]) {
    assert.equal(properties[field].type, "array");
    assert.equal(properties[field].maxItems, 200);
    for (const stream of [false, true]) {
      const domains = ["sec.gov", "example.com/blog", ".gov", ".co.uk"];
      await h.execute("responses", { input: "test", [field]: domains, stream, previous_response_id: "prior" });
      assert.deepEqual(h.calls.at(-1)!.body.tools, [{ type: "web_search", filters: { [field]: domains } }]);
      assert.equal(h.calls.at(-1)!.body.previous_response_id, "prior");
    }
  }
  await h.execute("responses", { input: "follow-up", previous_response_id: "prior" });
  assert.equal(h.calls.at(-1)!.body.tools, undefined);
  assert.equal(h.calls.at(-1)!.body.reasoning.effort, "low");
});

test("all nine tools remain, declarations shrink and routing preserves conversational follow-ups", async t => {
  const h = await setup(t, () => { throw new Error("no network expected"); });
  const definitions: any[] = [...h.tools.values()];
  assert.deepEqual([...h.tools.keys()].sort(), ["account", "extract", "findall", "group", "memory", "monitor", "responses", "search", "task"].map(x => `parallel_${x}`).sort());
  const bytes = Buffer.byteLength(JSON.stringify(definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))));
  assert.ok(bytes < 17183, `${bytes} must be smaller than the assessment baseline`);
  for (const name of ["search", "extract", "responses", "task", "group", "findall", "monitor"]) {
    const description = h.tools.get(`parallel_${name}`).description;
    assert.match(description, /\$/);
    if (name !== "findall") assert.doesNotMatch(description, /\$0\.03\/match/);
  }
  for (const name of ["task", "group"]) assert.ok(h.tools.get(`parallel_${name}`).parameters.properties.output_schema);
  const guidelines = h.tools.get("parallel_responses").promptGuidelines.join(" ");
  assert.match(guidelines, /concrete evidence gap/);
  assert.match(guidelines, /previous_response_id/);
  assert.doesNotMatch(guidelines, /one-shot/);
  t.diagnostic(`Tool definition bytes: ${bytes} (baseline 17183)`);
});
