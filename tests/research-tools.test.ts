import assert from "node:assert/strict";
import test from "node:test";
import { setup, type Call } from "./helpers/test-host.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const searchBody = {
  search_id: "search_remote_1",
  session_id: "pss_remote_1",
  results: [
    { url: "https://example.org/alpha", title: "Alpha paper", publish_date: "2026-02-03", excerpts: ["Alpha findings mention a durable log.", "A second alpha excerpt."] },
    { url: "https://example.org/beta", title: "Beta note", excerpts: ["Beta is unrelated to the question."] },
  ],
};
const extractBody = {
  extract_id: "extract_remote_1",
  session_id: "pss_remote_1",
  results: [{ url: "https://example.org/alpha", title: "Alpha page", excerpts: ["alpha excerpt"], full_content: "The complete alpha page text, long enough to be read in slices if needed." }],
  errors: [],
};

function host(calls?: Call[]) {
  let n = 0;
  return (call: Call) => {
    calls?.push(call);
    n += 1;
    if (call.path === "/v1/search") return json({ ...searchBody, search_id: `search_remote_${n}` });
    if (call.path === "/v1/extract") return json({ ...extractBody, extract_id: `extract_remote_${n}` });
    return json({ error: `unexpected ${call.path}` }, 500);
  };
}

test("web_search returns a bounded receipt and stores readable evidence", async t => {
  const h = await setup(t, host());
  await h.start();
  const out = await h.call("web_search", {
    objective: "How do durable write-ahead logs behave under crash",
    search_queries: ["crash durable log", "write-ahead log recovery"],
    include_domains: ["example.org"],
  });

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.path, "/v1/search");
  assert.deepEqual(h.calls[0]!.body.search_queries, ["crash durable log", "write-ahead log recovery"]);
  assert.equal(h.calls[0]!.body.objective, "How do durable write-ahead logs behave under crash");
  assert.equal(h.calls[0]!.body.mode, "basic", "basic is the explicit default");
  assert.equal(h.calls[0]!.body.session_id, undefined, "a first search opens a new provider context");

  assert.match(out.text, /Searched 2 sources/);
  assert.match(out.text, /Context handle: run_[0-9a-f]{16}/);
  assert.match(out.text, /web_recall \{ query \}/);
  assert.doesNotMatch(out.text, /search_remote_1|pss_remote_1/, "provider identities stay local");

  const handles = out.details.handles as string[];
  assert.equal(handles.length, 2);
  assert.match(handles[0]!, /^ev_[0-9a-f]{16}$/);

  const read = await h.call("web_recall", { handle: handles[0] });
  assert.match(read.text, /Alpha paper/);
  assert.match(read.text, /durable log/);
  assert.equal(read.details.kind, "excerpt");
  assert.equal(read.details.origin, "provider_source");

  const found = await h.call("web_recall", { query: "unrelated" });
  assert.match(found.text, /Beta note/);
  assert.doesNotMatch(found.text, /Alpha paper/, "a query ranks and filters stored evidence");

  const byRecord = await h.call("web_recall", { reference: String(out.details.reference), limit: 10 });
  assert.equal(byRecord.details.hits, 2, "a run reference lists that record's evidence");
});

test("a context handle keeps a second search in the same provider session", async t => {
  const h = await setup(t, host());
  await h.start();
  const first = await h.call("web_search", { search_queries: ["first angle"] });
  await h.call("web_search", { search_queries: ["second angle"], context: String(first.details.context) });
  assert.equal(h.calls[1]!.body.session_id, "pss_remote_1");
  await h.call("web_fetch", { urls: ["https://example.org/alpha"], context: String(first.details.context) });
  assert.equal(h.calls[2]!.body.session_id, "pss_remote_1");
});

test("web_fetch stores full content and reports per-URL failures", async t => {
  const h = await setup(t, (call) => {
    if (call.path !== "/v1/extract") return json({ error: "unexpected" }, 500);
    return json({
      ...extractBody,
      results: [{ ...extractBody.results[0]! }],
      errors: [{ url: "https://example.org/missing", error_type: "http_error", http_status_code: 404, content: "not found" }],
    });
  });
  await h.start();
  const out = await h.call("web_fetch", {
    urls: ["https://example.org/alpha", "https://example.org/missing"],
    objective: "whole page",
    full_content: true,
  });

  assert.equal(h.calls[0]!.body.advanced_settings.full_content, true);
  assert.match(out.text, /Read 1 of 2 URLs/);
  assert.match(out.text, /http_error \(HTTP 404\)/);
  assert.equal(out.details.saved, 1);
  assert.equal(out.details.failed, 1);

  const [handle] = out.details.handles as string[];
  const read = await h.call("web_recall", { handle });
  assert.match(read.text, /The complete alpha page text/);
  assert.equal(read.details.kind, "source", "full content is stored as source evidence");
});

test("evidence is invisible to another Pi session and visible again after a reload", async t => {
  const h = await setup(t, host());
  await h.start();
  const out = await h.call("web_search", { search_queries: ["shared angle"] });
  const handle = String((out.details.handles as string[])[0]);

  const other = await h.instance("session-b");
  await other.start();
  const hidden = await other.call("web_recall", { query: "durable" });
  assert.match(hidden.text, /No stored evidence/);
  await assert.rejects(() => other.call("web_recall", { handle }), /No evidence/, "a foreign handle behaves like a missing one");

  const reloaded = await h.instance("session-a");
  await reloaded.start();
  const again = await reloaded.call("web_recall", { query: "durable" });
  assert.equal(again.details.hits, 1, "the same Pi session sees its evidence after a reload");
});

test("a replayed tool invocation does not pay twice", async t => {
  const h = await setup(t, host());
  await h.start();
  const tool = h.tools.get("web_search");
  const args = { search_queries: ["once"] };
  const a = await tool.execute("pi-call-1", args, undefined, undefined, h.ctx);
  const b = await tool.execute("pi-call-1", args, undefined, undefined, h.ctx);
  assert.equal(h.calls.length, 1, "one provider request for two executions of the same invocation");
  assert.match(b.content[0].text, /already submitted/);
  assert.match(a.content[0].text, /Searched/);
});

test("the research tools refuse to run outside a started session", async t => {
  const h = await setup(t, host());
  await assert.rejects(() => h.run("web_search", { search_queries: ["a"] }), /not started/);
  await assert.rejects(() => h.run("web_recall", { query: "a" }), /not started/);
  await assert.rejects(() => h.run("web_research", { input: "a" }), /not started/);
  await assert.rejects(() => h.run("web_answer", { question: "a" }), /not started/);
  assert.equal(h.calls.length, 0);
});

const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
  headers: { "Content-Type": "text/event-stream" },
});

function taskHost() {
  const state = { events: 0, groups: 0, submissions: 0, answers: 0 };
  const handler = (call: Call) => {
    if (call.path === "/v1/tasks/groups" && call.method === "POST") {
      state.groups += 1;
      return json({ taskgroup_id: "tg_1", status: { is_active: true } });
    }
    if (call.path === "/v1/tasks/groups/tg_1/runs" && call.method === "POST") {
      state.submissions += 1;
      return json({ run_ids: ["trun_1"], event_cursor: "cur_1", status: { is_active: true } });
    }
    if (call.path === "/v1/tasks/runs/trun_1" && call.method === "GET") {
      return json({ run_id: "trun_1", status: "running", interaction_id: "int_1", taskgroup_id: "tg_1" });
    }
    if (call.path === "/v1/tasks/runs/trun_1/events") {
      state.events += 1;
      return sse([
        { type: "task_run.state", event_id: "", run: { run_id: "trun_1", status: "running", interaction_id: "int_1" } },
        { type: "task_run.progress_stats", progress_meter: 55, source_stats: { num_sources_considered: 4 } },
        { type: "task_run.state", event_id: "", run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" }, output: { content: "Final report text about engines.", basis: [] } },
      ]);
    }
    if (call.path === "/v1/tasks/runs/trun_1/result") {
      return json({ run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" }, output: { content: "Final report text about engines.", basis: [] } });
    }
    if (call.path === "/v1/responses") {
      state.answers += 1;
      return json({
        id: `resp_${state.answers}`,
        status: "completed",
        output_text: "A cited answer.",
        output: [{ type: "message", content: [{ type: "output_text", text: "A cited answer.", annotations: [] }] }],
      });
    }
    return json({ error: `unexpected ${call.path}` }, 500);
  };
  return { handler, state };
}

test("web_research submits once, collects the run, and delivers a completion alert", async t => {
  const { handler, state } = taskHost();
  const h = await setup(t, handler);
  await h.start();
  const out = await h.call("web_research", { input: "Compare engines", processor: "core", output_description: "which engine wins" });
  assert.match(out.text, /Research submitted: run_[0-9a-f]{16}/);
  assert.equal(state.submissions, 1);

  const reference = String(out.details.reference);
  const deadline = Date.now() + 5000;
  const delivered = () => h.sent.some(message => JSON.stringify(message).includes("Research completed"));
  while (Date.now() < deadline && !delivered()) await new Promise(resolveWait => setTimeout(resolveWait, 20));
  assert.ok(delivered(), "the completion alert reached Pi as a follow-up");
  const indexed = await h.call("web_recall", { reference });
  const read = await h.call("web_recall", { handle: String((indexed.details.handles as string[])[0]) });
  assert.match(read.text, /Final report text about engines/);
});

test("web_answer stores a cited answer and continues from it", async t => {
  const { handler } = taskHost();
  const h = await setup(t, handler);
  await h.start();
  const first = await h.call("web_answer", { question: "why?" });
  assert.match(first.text, /A cited answer/);
  await h.call("web_answer", { question: "and then?", continue_from: String(first.details.reference) });
  const posted = h.calls.filter(call => call.path === "/v1/responses");
  assert.equal(posted.length, 2);
  assert.equal(posted[1]!.body.previous_response_id, "resp_1");
});

test("stored evidence outlives the runtime and the store closes cleanly", async t => {
  const h = await setup(t, host());
  await h.start();
  await h.call("web_search", { search_queries: ["persisted"] });
  await h.stop();
  const again = await h.instance("session-a");
  await again.start();
  const found = await again.call("web_recall", { query: "durable" });
  assert.equal(found.details.hits, 1);
  await again.stop();
});
