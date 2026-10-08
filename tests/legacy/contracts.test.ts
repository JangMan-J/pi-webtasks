import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { setup } from "../helpers/test-host.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { PREVIEW_LIMIT } from "../../src/results.ts";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const answer = {
  id: "response", status: "completed",
  output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: "A cited answer", annotations: [] }] }],
};
const saved = async (receipt: any) => JSON.parse(await readFile(receipt.artifact, "utf8"));
async function failed(promise: Promise<unknown>) {
  let receipt: any;
  await assert.rejects(promise, err => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.length <= PREVIEW_LIMIT);
    receipt = JSON.parse(err.message);
    return true;
  });
  return { receipt, data: await saved(receipt) };
}

test("Responses rejects invalid filters, conversations and metadata before HTTP", async t => {
  const h = await setup(t, () => json(answer));
  const invalid = [
    ...["https://example.com", "example.com:443", "example.com?q=x", "example.com#x", "*.gov", "", "bad domain.com", "user@example.com", "example..com", "-bad.com", "example.com\\path", ".gov/path", 42].map(x => ({ allowed_domains: [x] })),
    { allowed_domains: "example.com" }, { allowed_domains: Array(201).fill("example.com") },
    { allowed_domains: ["example.com"], blocked_domains: ["blog.example.com"] },
    { allowed_domains: ["example.com"], blocked_domains: ["other.com"] },
    { allowed_domains: [], blocked_domains: [] },
    { input: [{ role: "assistant", content: "No user" }] },
    { input: [{ role: "user", content: " " }] },
    { input: [{ role: "user", content: [{ type: "input_image" }] }] },
    { input: [{ role: "tool", content: "invalid role" }] }, { input: [null] },
    ...[[], "[]", "null", "", { tag: 1 }, { tag: "x".repeat(513) }, { ["x".repeat(65)]: "value" }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i), "v"]))].map(metadata => ({ metadata })),
  ];
  for (const args of invalid) await failed(h.execute("responses", { input: "test", ...args }));
  assert.equal(h.calls.length, 0);
  const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i).padEnd(64, "x"), "🦄".repeat(512)]));
  const input = [{ role: "system", content: "Cite sources" }, { role: "user", content: "Question" }, { role: "assistant", content: "Answer" }, { role: "user", content: "Follow-up" }];
  for (const tags of [metadata, JSON.stringify(metadata)]) {
    const args = { input, metadata: tags, allowed_domains: Array(200).fill("example.com/path") };
    assert.deepEqual(validateToolArguments(h.tools.get("parallel_responses"), { type: "toolCall", id: "schema", name: "parallel_responses", arguments: args }), args);
    await h.execute("responses", args);
    assert.deepEqual(h.calls.at(-1)!.body.metadata, metadata);
    assert.deepEqual(h.calls.at(-1)!.body.input, input);
  }
});

test("Search and Extract validate integer controls and turbo path restrictions locally", async t => {
  const h = await setup(t, () => json({ results: [] }));
  for (const [name, base] of [["search", { search_queries: ["test"] }], ["extract", { urls: ["https://example.com"] }]] as const) {
    const properties = h.tools.get(`parallel_${name}`).parameters.properties;
    assert.equal(properties.max_chars_total.type, "integer");
    assert.equal(properties.max_age_seconds.minimum, 600);
    for (const args of [{ max_chars_total: 1.5 }, { max_chars_per_result: 1.5 }, { max_age_seconds: 1 }, { max_age_seconds: 600.5 }]) {
      await failed(h.execute(name, { ...base, ...args }));
    }
  }
  await failed(h.execute("search", { search_queries: ["test"], max_results: 1.5 }));
  await failed(h.execute("extract", { urls: ["https://example.com"], full_content: { max_chars_per_result: 1.5 } }));
  for (const policy of [{ include_domains: ["example.com/blog"] }, { source_policy: '{"exclude_domains":["example.com/blog"]}' }]) {
    await failed(h.execute("search", { search_queries: ["test"], mode: "turbo", ...policy }));
  }
  assert.equal(h.calls.length, 0);
  await h.execute("search", { search_queries: ["test"], mode: "fast", max_results: 4, max_chars_total: 1200, max_chars_per_result: 300, max_age_seconds: 600, include_domains: ["example.com/blog"] });
  assert.deepEqual(h.calls.at(-1)!.body.advanced_settings, { max_results: 4, source_policy: { include_domains: ["example.com/blog"] }, fetch_policy: { max_age_seconds: 600 }, excerpt_settings: { max_chars_per_result: 300 } });
  await h.execute("search", { search_queries: ["test"], mode: "turbo", include_domains: ["example.com", ".gov"] });
  await h.execute("extract", { urls: ["https://example.com"], max_chars_total: 1200, max_chars_per_result: 300, max_age_seconds: 600, full_content: { max_chars_per_result: 4000 } });
  assert.deepEqual(h.calls.at(-1)!.body.advanced_settings, { fetch_policy: { max_age_seconds: 600 }, excerpt_settings: { max_chars_per_result: 300 }, full_content: { max_chars_per_result: 4000 } });
});

test("retrieval defaults and overrides stay independent of local preview budgets", async t => {
  const h = await setup(t, () => json({ results: [] }));
  await h.execute("search", { search_queries: ["test"], preview_chars: 2000 });
  const search = h.calls.at(-1)!.body;
  assert.equal(search.max_chars_total, 50_000);
  assert.deepEqual(search.advanced_settings, { max_results: 20, excerpt_settings: { max_chars_per_result: 10_000 } });
  assert.equal("preview_chars" in search, false);
  await h.execute("extract", { urls: ["https://example.com"], preview_chars: 64000 });
  const extract = h.calls.at(-1)!.body;
  assert.equal(extract.max_chars_total, 100_000);
  assert.deepEqual(extract.advanced_settings, { excerpt_settings: { max_chars_per_result: 20_000 }, full_content: true });
  assert.equal("preview_chars" in extract, false);
  await h.execute("extract", { urls: ["https://example.com"], full_content: false, max_chars_total: 3000, max_chars_per_result: 1500 });
  assert.equal(h.calls.at(-1)!.body.max_chars_total, 3000);
  assert.deepEqual(h.calls.at(-1)!.body.advanced_settings, { excerpt_settings: { max_chars_per_result: 1500 }, full_content: false });
  assert.equal(h.calls.length, 3);
});

test("invalid local preview budgets reject before any API request", async t => {
  const h = await setup(t, () => { throw new Error("No API request expected"); });
  for (const [name, args] of [
    ["search", { search_queries: ["test"] }],
    ["extract", { urls: ["https://example.com"] }],
    ["task", { action: "create", input: "test", processor: "base" }],
  ] as const) {
    const property = h.tools.get(`parallel_${name}`).parameters.properties.preview_chars;
    assert.equal(property.minimum, 2000);
    assert.equal(property.maximum, 64000);
    for (const preview_chars of [1999, 64001, 2000.5, "24000", null]) {
      await assert.rejects(h.execute(name, { ...args, preview_chars }), /preview_chars/);
    }
  }
  assert.equal(h.calls.length, 0);
});

test("Task result preview budget changes returned evidence without another creation", async t => {
  const content = "Useful report paragraph.\n".repeat(420);
  const data = { run: { run_id: "known-task", status: "completed" }, output: { content, basis: [{ field: "content", confidence: "low", citations: [{ url: "https://example.com/evidence" }] }] } };
  const h = await setup(t, () => json(data));
  const small = await h.execute("task", { action: "result", run_id: "known-task", preview_chars: 8000 });
  const large = await h.execute("task", { action: "result", run_id: "known-task", preview_chars: 24000 });
  assert.ok(small.preview.output.content.length < content.length);
  assert.equal(large.preview.output.content, content);
  assert.equal(large.preview.output.basis[0].confidence, "low");
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.method === "GET"));
  assert.deepEqual(await saved(small), await saved(large));
});

test("Task accepts structured input and delivers narrative evidence without repeat creation", async t => {
  const output = { content: "A narrative report", basis: [
    { field: "output", confidence: "low", reasoning: "Only one source", citations: [{ url: "https://example.com", excerpts: ["Supporting passage"] }] },
    { field: "entities.0", confidence: null, citations: [] },
  ] };
  const h = await setup(t, call => json(call.method === "POST" ? { run_id: "task", status: "running" } : { run: { run_id: "task", interaction_id: "interaction", status: "completed" }, output }));
  const field = h.tools.get("parallel_task").parameters.properties.input;
  assert.ok(field.anyOf.some((s: any) => s.type === "object"));
  const input = { country: "France", year: 2023 };
  const task_spec = { output_schema: { type: "text", description: "Cited report" } };
  const args = { action: "create", input, processor: "base", task_spec: JSON.stringify(task_spec) };
  assert.deepEqual(validateToolArguments(h.tools.get("parallel_task"), { type: "toolCall", id: "schema", name: "parallel_task", arguments: args }), args);
  const creation = await h.execute("task", args);
  assert.deepEqual(h.calls[0]!.body.input, input);
  assert.deepEqual(h.calls[0]!.body.task_spec, task_spec);
  const result = await h.execute("task", { action: "result", run_id: creation.control.run_id });
  assert.deepEqual(result.preview.output, output);
  assert.deepEqual((await saved(result)).output, output);
  assert.equal(result.control["run.interaction_id"], "interaction");
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
  await h.execute("task", { action: "create", input: "follow-up", processor: "base-fast", previous_interaction_id: "interaction" });
  assert.equal(h.calls.at(-1)!.body.processor, "base-fast");
  assert.equal(h.calls.at(-1)!.body.previous_interaction_id, "interaction");
  const before = h.calls.length;
  for (const input of [[], 3, false, " "]) await failed(h.execute("task", { action: "create", input, processor: "base" }));
  assert.equal(h.calls.length, before);
  const guidance = h.tools.get("parallel_task").promptGuidelines.join(" ");
  assert.match(guidance, /standard base\/core/);
  assert.match(guidance, /parallel_responses for low latency/);
  assert.doesNotMatch(guidance, /Fast variants reduce latency/);
});

test("Monitor rejects create-only update fields but keeps supported settings", async t => {
  const h = await setup(t, () => json({ monitor_id: "monitor" }));
  for (const extra of [{ include_backfill: false }, { output_schema: '{}' }, { task_run_id: "task" }, { memory_scope_key: "scope" }]) {
    await failed(h.execute("monitor", { action: "update", monitor_id: "monitor", query: "new", ...extra }));
  }
  assert.equal(h.calls.length, 0);
  await h.execute("monitor", { action: "update", monitor_id: "monitor", query: "new", processor: "base", include_domains: ["example.com"] });
  assert.deepEqual(h.calls[0]!.body, { processor: "base", type: "event_stream", settings: { query: "new", advanced_settings: { source_policy: { include_domains: ["example.com"] } } } });
  await h.execute("monitor", { action: "create", query: "new", frequency: "1d", include_backfill: false, output_schema: '{"type":"object"}' });
  assert.equal(h.calls.at(-1)!.body.settings.include_backfill, false);
  assert.deepEqual(h.calls.at(-1)!.body.settings.output_schema, { type: "object" });
});

test("Responses rejects incomplete response or message status and preserves partial content", async t => {
  let response: any = answer;
  const h = await setup(t, call => call.body.stream ? sse([{ type: "response.completed", response }]) : json(response));
  for (const status of ["failed", "incomplete", "in_progress"]) {
    response = { ...answer, status, incomplete_details: { reason: "fixture" }, api_key: "hidden" };
    const { receipt, data } = await failed(h.execute("responses", { input: "test" }));
    assert.equal(receipt.control["response.id"], "response");
    assert.equal(receipt.control.partial, true);
    assert.equal(data.output_text, "A cited answer");
    assert.equal(data.response.incomplete_details.reason, "fixture");
    assert.equal(data.response.api_key, "[redacted]");
  }
  response = { ...answer, output: [{ ...answer.output[0], status: "incomplete" }] };
  for (const stream of [false, true]) await failed(h.execute("responses", { input: "test", stream }));
  response = answer;
  const receipt = await h.execute("responses", { input: "test" });
  assert.equal(receipt.control["response.status"], "completed");
});

test("Unicode citation previews label original offsets and expose the search trail", async t => {
  const block = { type: "output_text", text: "🦄".repeat(600) + "Cited passage", annotations: [{ type: "url_citation", url: "https://example.com", title: "Evidence", start_index: 600, end_index: 613 }] };
  const response = { ...answer, output: [
    { type: "web_search_call", action: { type: "search", queries: ["query"] } },
    { type: "web_search_call", action: { type: "open_page", url: "https://example.com" } },
    { type: "message", status: "completed", content: [block] },
  ] };
  const h = await setup(t, () => json(response));
  const receipt = await h.execute("responses", { input: "test" });
  const preview = receipt.preview.answer[0];
  assert.equal(preview.content, block.text);
  assert.equal(preview.content.isWellFormed(), true);
  assert.match(preview.annotation_offsets, /original artifact text/i);
  assert.equal(preview.annotations[0].title, "Evidence");
  assert.equal(preview.annotations[0].start_index, 600);
  assert.equal(receipt.preview.search_trail.searches, 1);
  assert.equal(receipt.preview.search_trail.page_read_attempts, 1);
  assert.equal(receipt.preview.search_trail.artifact_field, "response.output");
  assert.match(receipt.preview.search_trail.notice, /do not prove successful retrieval/);
  assert.deepEqual((await saved(receipt)).response, response);
});

test("Task replay passes 40 events and Group collection continues without duplicate submissions", async t => {
  const events = Array.from({ length: 45 }, (_, i) => ({ event_id: `event-${i + 1}`, type: "task_run.state", run: { run_id: `run-${i + 1}`, status: "completed" }, output: { content: `answer-${i + 1}`, basis: [] } }));
  const h = await setup(t, call => {
    if (call.method === "POST") return json({ taskgroup_id: "group", run_ids: events.map(e => e.run.run_id) });
    const cursor = call.query.get("last_event_id");
    const offset = cursor ? events.findIndex(e => e.event_id === cursor) + 1 : 0;
    return sse(call.path.includes("/groups/") ? events.slice(offset) : events.map(({ event_id, ...e }) => e));
  });
  const task = await h.execute("task", { action: "events", run_id: "task" });
  assert.equal((await saved(task)).events.length, 45);
  assert.equal(task.control.last_event_id, null);
  assert.equal(task.control.limit_reached, false);
  const creation = await h.execute("group", { action: "create" });
  await h.execute("group", { action: "add", taskgroup_id: creation.control.taskgroup_id, inputs: JSON.stringify(events.map(e => ({ input: e.run.run_id, processor: "base" }))) });
  const all: any[] = [];
  let last_event_id: string | undefined;
  for (let i = 0; i < 3; i++) {
    const page = await h.execute("group", { action: "runs", taskgroup_id: "group", include_output: true, last_event_id });
    assert.equal(h.calls.at(-1)!.query.get("include_output"), "true");
    all.push(...(await saved(page)).events);
    last_event_id = page.control.last_event_id;
    if (!page.control.limit_reached) break;
  }
  assert.deepEqual(all, events);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 2);
  assert.equal(last_event_id, "event-45");
});

test("stream deadlines cover open bodies, preserve partial events, and abort HTTP", async t => {
  const h = await setup(t, call => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"event_id":"first","type":"progress"}\n\n'));
      call.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  for (const [name, args] of [["task", { run_id: "task", action: "events" }], ["group", { taskgroup_id: "group", action: "runs" }], ["group", { taskgroup_id: "group", action: "events" }], ["findall", { findall_id: "findall", action: "events" }]] as const) {
    const start = performance.now();
    const receipt = await h.execute(name, { ...args, wait_seconds: 0.03 });
    assert.ok(performance.now() - start < 1000);
    assert.equal(h.calls.at(-1)!.signal.aborted, true);
    assert.equal(receipt.control.timeout, true);
    assert.equal(receipt.control.partial, true);
    assert.equal(receipt.control.last_event_id, "first");
    assert.equal((await saved(receipt)).events.length, 1);
  }
});

test("stream deadlines also cover connection setup and retain the incoming cursor", async t => {
  const h = await setup(t, call => new Promise((_resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("deadline failed to abort request")), 500);
    call.signal.addEventListener("abort", () => { clearTimeout(guard); reject(call.signal.reason); }, { once: true });
  }));
  const receipt = await h.execute("group", { action: "runs", taskgroup_id: "group", last_event_id: "prior", wait_seconds: 0.03 });
  assert.equal(receipt.control.timeout, true);
  assert.equal(receipt.control.last_event_id, "prior");
  assert.equal(receipt.control.taskgroup_id, "group");
  assert.deepEqual((await saved(receipt)).events, []);
  assert.equal(h.calls.length, 1);
});

test("stream error events and cancellation are errors rather than successful EOF", async t => {
  let events: any[] = [];
  const h = await setup(t, () => sse(events));
  for (const name of ["task", "group", "findall"]) {
    const args = { action: "events", run_id: "task", taskgroup_id: "group", findall_id: "findall" };
    events = [{ event_id: "first", type: "progress" }, { type: "error", error: { message: "fixture stream error" } }];
    const failure = await failed(h.execute(name, args));
    assert.equal(failure.data.partial, true);
    assert.equal(failure.data.events.length, 2);
    assert.equal(failure.receipt.control.last_event_id, "first");
    const controller = new AbortController();
    events = [{ event_id: "first", type: "progress" }];
    const cancelled = await failed(h.execute(name, args, controller.signal, () => controller.abort()));
    assert.equal(cancelled.data.partial, true);
    assert.equal(cancelled.data.events.length, 1);
    assert.equal(cancelled.data.timeout, undefined);
  }
});
