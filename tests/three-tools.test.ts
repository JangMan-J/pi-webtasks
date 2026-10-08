import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import { setup, type Call } from "./helpers/test-host.ts";

const CALLBACK = "https://callbacks.example.test/hook";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const REF = /^research_[0-9a-f-]{36}$/;
const CONV = /^conversation_[0-9a-f-]{36}$/;

const searchPayload = { search_id: "search_secret_1", results: [{ url: "https://example.org/a", title: "A", excerpts: ["alpha fact"], full_content: null }] };
let answers = 0;
function responsesReply(call: Call) {
  answers++;
  return json({ id: `resp_${answers}`, status: "completed", output_text: `answer ${answers}`, output: [], request: call.body });
}

function deepHost(onGroup?: () => Promise<void>) {
  let runs = 0;
  return async (call: Call) => {
    if (call.path === "/v1/tasks/groups" && call.method === "POST") { await onGroup?.(); return json({ taskgroup_id: "tg_1", status: { is_active: false } }); }
    if (/\/runs$/.test(call.path) && call.method === "POST") return json({ run_ids: [`run_${++runs}`], status: { is_active: true } });
    if (/^\/v1\/tasks\/runs\/run_\d+$/.test(call.path)) return json({ run_id: "run_1", status: "running" });
    return json({ error: `unexpected ${call.method} ${call.path}` }, 500);
  };
}
const posts = (calls: Call[], re: RegExp) => calls.filter(c => c.method === "POST" && re.test(c.path));
async function store(dir: string) { return new WebhookInbox(dir); }

test("exactly three tools with closed schemas and no backend vocabulary", async t => {
  const h = await setup(t, () => json({}));
  assert.deepEqual([...h.tools.keys()].sort(), ["deep_search", "interactive_search", "web_search"]);
  for (const tool of h.tools.values() as Iterable<any>) {
    assert.equal(tool.parameters.additionalProperties, false);
    const surface = JSON.stringify([tool.description, tool.promptSnippet, tool.promptGuidelines, tool.parameters]);
    assert.doesNotMatch(surface, /processor|taskgroup|run_id|webhook|response_id|\b(base|core|pro|ultra)\b|parallel/i);
  }
});

test("invalid input is rejected before any network request or setup", async t => {
  const h = await setup(t, deepHost(), { webhookDir: undefined });
  await h.start();
  const bad: [string, Record<string, unknown>][] = [
    ["web_search", {}], ["web_search", { query: "   " }], ["web_search", { urls: ["ftp://x.test/a"] }],
    ["web_search", { urls: ["https://a.test/x"], domains: ["a.test"] }], ["web_search", { query: "q", domains: ["bad domain"] }],
    ["web_search", { query: "q", extra: 1 }],
    ["interactive_search", { question: " " }], ["interactive_search", { question: "q", effort: "max" }],
    ["interactive_search", { question: "q", conversation: "../etc/passwd" }],
    ["interactive_search", { question: "q", conversation: "conversation_00000000-0000-0000-0000-000000000000" }],
    ["deep_search", {}], ["deep_search", { query: [] }], ["deep_search", { query: ["ok", " "] }],
    ["deep_search", { research: "nope" }], ["deep_search", { research: "conversation_00000000-0000-0000-0000-000000000000" }],
    ["deep_search", { research: "research_00000000-0000-0000-0000-000000000000", effort: "low" }],
    ["deep_search", { research: "research_00000000-0000-0000-0000-000000000000", domains: ["a.test"] }],
    ["deep_search", { query: "needs a callback" }], // no inbox or callback configured
    ["web_search", { query: "q", effort: "max" }],
    ...["low", "medium", "high"].flatMap(effort => [
      ["web_search", { urls: ["https://a.test/x"], effort }], ["web_search", { entity: "people", query: "q", effort }],
    ] as [string, Record<string, unknown>][]),
  ];
  for (const [name, args] of bad) await assert.rejects(h.run(name, args), undefined, `${name} ${JSON.stringify(args)}`);
  assert.equal(h.calls.length, 0);
});

test("web_search maps a query to fast discovery and URLs to full-content reading, hiding remote IDs", async t => {
  const h = await setup(t, () => json(searchPayload));
  await h.start();
  const found = await h.call("web_search", { query: "alpha fact", domains: ["example.org"] });
  assert.equal(h.calls[0]!.path, "/v1/search");
  assert.equal(h.calls[0]!.body.mode, "fast");
  assert.equal(h.calls[0]!.body.advanced_settings.max_results, 10, "stays within the included result count");
  assert.deepEqual(h.calls[0]!.body.search_queries, ["alpha fact"]);
  assert.deepEqual(h.calls[0]!.body.advanced_settings.source_policy.include_domains, ["example.org"]);
  const read = await h.call("web_search", { urls: ["https://example.org/a"], query: "focus" });
  assert.equal(h.calls[1]!.path, "/v1/extract");
  assert.equal(h.calls[1]!.body.advanced_settings.full_content, true);
  assert.equal(h.calls[1]!.body.objective, "focus");
  for (const out of [found, read]) {
    assert.match(out.text, /alpha fact/);
    assert.doesNotMatch(out.text, /search_secret_1/);
    assert.ok(out.details.artifact.includes(join("agent", "webtasks", "results")));
  }
  assert.match(await readFile(found.details.artifact, "utf8"), /search_secret_1/, "raw artifact keeps diagnostics");
});

test("interactive answers get immutable references; follow-ups resolve the previous answer internally", async t => {
  answers = 0;
  const h = await setup(t, responsesReply);
  await h.start();
  const one = await h.call("interactive_search", { question: "first?" });
  const refOne = one.details.conversation;
  assert.match(refOne, CONV);
  const two = await h.call("interactive_search", { question: "and then?", conversation: refOne });
  const three = await h.call("interactive_search", { question: "branch", conversation: refOne, effort: "high" });
  assert.equal(h.calls[1]!.body.previous_response_id, "resp_1");
  assert.equal(h.calls[2]!.body.previous_response_id, "resp_1", "continuing the first reference again is a sibling, not an overwrite");
  assert.equal(h.calls[2]!.body.reasoning.effort, "high");
  assert.equal(new Set([refOne, two.details.conversation, three.details.conversation]).size, 3);
  for (const out of [one, two, three]) assert.doesNotMatch(out.text, /resp_\d/);
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  assert.equal((await db.getConversation(two.details.conversation))!.parent, refOne);
  assert.equal((await db.getConversation(refOne))!.response_id, "resp_1");
});

test("an uncertain conversational request is recorded, not repeated, and cannot be continued", async t => {
  const h = await setup(t, () => json({ error: "boom" }, 503));
  await h.start();
  const err: any = await h.run("interactive_search", { question: "q" }).catch(e => e);
  assert.ok(err instanceof Error);
  const ref = /conversation_[0-9a-f-]{36}/.exec(err.message)?.[0];
  assert.ok(ref, err.message);
  assert.match(err.message, /uncertain/);
  assert.equal(h.calls.length, 1, "no automatic retry");
  await assert.rejects(h.run("interactive_search", { question: "again", conversation: ref }), /cannot be continued/);
  assert.equal(h.calls.length, 1);
});

test("session start only looks up; the first deep submission creates the group once, even concurrently", async t => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const h = await setup(t, deepHost(() => gate), { webhookDir: join((await import("node:os")).tmpdir(), `wt-${process.pid}-${Date.now()}`), webhookUrl: CALLBACK });
  await mkdir(h.inboxDir, { recursive: true });
  await h.start();
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  assert.equal(await db.getSessionGroup("session-a"), undefined, "session_start wrote nothing");
  // Reads and routine tools never create a group.
  await assert.rejects(h.run("deep_search", { research: "research_00000000-0000-0000-0000-000000000000" }), /Unknown research/);
  assert.equal(await db.getSessionGroup("session-a"), undefined);
  const pending = [h.call("deep_search", { query: "one" }), h.call("deep_search", { query: ["two", "three"], effort: "high", domains: ["example.org"] }), h.call("deep_search", { query: "four" })];
  await new Promise(r => setTimeout(r, 100));
  assert.equal(posts(h.calls, /\/v1\/tasks\/groups$/).length, 1, "single-flight creation while the first is unresolved");
  release();
  const results = await Promise.all(pending);
  assert.equal(posts(h.calls, /\/v1\/tasks\/groups$/).length, 1);
  const adds = posts(h.calls, /\/runs$/);
  assert.equal(adds.length, 4, "one input per add request");
  for (const add of adds) assert.equal(add.body.inputs.length, 1);
  const group = await db.getSessionGroup("session-a");
  assert.equal(group!.status, "ready");
  assert.equal(group!.group_id, "tg_1");
  const refs = results.flatMap(r => r.details.references as string[]);
  assert.equal(refs.length, 4);
  for (const ref of refs) assert.match(ref, REF);
  const high = adds.find(a => a.body.inputs[0].input === "two")!.body.inputs[0];
  const record = (await db.getResearch(high.metadata.webtasks_ref))!;
  assert.deepEqual(high.metadata, { webtasks_ref: record.reference, webtasks_session: "session-a", webtasks_group: "tg_1" });
  assert.equal(high.processor, "ultra2x");
  assert.deepEqual(high.webhook, { url: CALLBACK, event_types: ["task_run.status"] });
  assert.deepEqual(high.source_policy, { include_domains: ["example.org"] });
  assert.equal(adds[0]!.body.default_task_spec.output_schema.type, "text");
  assert.equal(record.status, "pending");
  assert.ok(record.run_id);
  for (const r of results) assert.doesNotMatch(r.text, /run_\d|tg_1|ultra2x|core/);
});

test("reading a reference never submits; a reload reuses the saved group without recreating it", async t => {
  const dir = join((await import("node:os")).tmpdir(), `wt-reload-${process.pid}-${Date.now()}`);
  const h = await setup(t, deepHost(), { webhookDir: dir, webhookUrl: CALLBACK });
  await h.start();
  const first = await h.call("deep_search", { query: "one" });
  const ref = first.details.references[0] as string;
  const before = h.calls.length;
  const read = await h.call("deep_search", { research: ref });
  assert.match(read.text, /Status: pending/);
  assert.deepEqual(h.calls.slice(before).map(c => `${c.method} ${c.path}`), ["GET /v1/tasks/runs/run_1"], "read-only status snapshot only");
  await h.stop();
  const reloaded = await h.instance("session-a");
  await reloaded.start();
  await reloaded.call("deep_search", { query: "two" });
  assert.equal(posts(h.calls, /\/v1\/tasks\/groups$/).length, 1);
  assert.equal(posts(h.calls, /\/runs$/).length, 2);
  // A different session gets its own group.
  const other = await h.instance("session-b");
  await other.start();
  await other.call("deep_search", { query: "three" });
  assert.equal(posts(h.calls, /\/v1\/tasks\/groups$/).length, 2);
});

test("an uncertain dispatch is persisted, never retried, and does not block later submissions", async t => {
  let failNext = true;
  const base = deepHost();
  const h = await setup(t, call => {
    if (failNext && /\/runs$/.test(call.path)) { failNext = false; return json({ error: "gateway" }, 502); }
    return base(call);
  }, { webhookDir: join((await import("node:os")).tmpdir(), `wt-unc-${process.pid}-${Date.now()}`), webhookUrl: CALLBACK });
  await h.start();
  const err: any = await h.run("deep_search", { query: "one" }).catch(e => e);
  assert.match(err.message, /uncertain/);
  assert.equal(posts(h.calls, /\/runs$/).length, 1, "no automatic add retry");
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const ref = /research_[0-9a-f-]{36}/.exec(err.message)![0];
  const record = (await db.getResearch(ref))!;
  assert.equal(record.status, "uncertain");
  assert.equal(record.run_id, undefined);
  const read = await h.call("deep_search", { research: ref });
  assert.match(read.text, /uncertain/);
  assert.equal(posts(h.calls, /\/runs$/).length, 1, "reading does not resubmit");
  await h.call("deep_search", { query: "two" });
  assert.equal(posts(h.calls, /\/v1\/tasks\/groups$/).length, 1);
});

test("stopping the session cancels the local wait and records the in-flight dispatch as uncertain", async t => {
  const base = deepHost();
  const h = await setup(t, call => {
    if (/\/runs$/.test(call.path)) return new Promise<Response>((_, reject) => call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    return base(call);
  }, { webhookDir: join((await import("node:os")).tmpdir(), `wt-stop-${process.pid}-${Date.now()}`), webhookUrl: CALLBACK });
  await h.start();
  const inflight = h.run("deep_search", { query: "one" }).catch(e => e);
  while (posts(h.calls, /\/runs$/).length === 0) await new Promise(r => setTimeout(r, 10));
  await h.stop();
  const err: any = await inflight;
  assert.ok(err instanceof Error);
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const ref = /research_[0-9a-f-]{36}/.exec(err.message)![0];
  assert.equal((await db.getResearch(ref))!.status, "uncertain");
  await assert.rejects(h.run("deep_search", { query: "after stop" }), /stopp|not started|stopped/i);
  assert.equal(posts(h.calls, /\/runs$/).length, 1);
});

test("a completed reference grounds a new follow-up; an unfinished one submits nothing", async t => {
  const dir = join((await import("node:os")).tmpdir(), `wt-follow-${process.pid}-${Date.now()}`);
  const h = await setup(t, deepHost(), { webhookDir: dir, webhookUrl: CALLBACK });
  await h.start();
  const first = await h.call("deep_search", { query: "original" });
  const ref = first.details.references[0] as string;
  const adds = () => posts(h.calls, /\/runs$/).length;
  await assert.rejects(h.run("deep_search", { query: "more", research: ref }), /not completed/);
  assert.equal(adds(), 1);
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const artifact = join(h.dir, "saved.json");
  await writeFile(artifact, JSON.stringify({ run: { interaction_id: "int_1" }, output: { content: "Finding: ALPHA-7", basis: [{ citations: [{ url: "https://src.example/a", title: "Src" }] }] } }));
  await db.updateResearch(ref, { status: "completed", artifact });
  const read = await h.call("deep_search", { research: ref });
  assert.match(read.text, /ALPHA-7/);
  assert.match(read.text, /https:\/\/src\.example\/a/);
  assert.doesNotMatch(read.text, /int_1/);
  const followed = await h.call("deep_search", { query: "more", research: ref });
  const sent = posts(h.calls, /\/runs$/).at(-1)!.body.inputs[0];
  assert.match(sent.input, /^more/);
  assert.match(sent.input, /ALPHA-7/);
  assert.equal(sent.previous_interaction_id, "int_1");
  assert.doesNotMatch(followed.text, /int_1/);
  assert.notEqual(followed.details.references[0], ref);
});

test("entity lookup validation rejects before any request", async t => {
  const h = await setup(t, () => json({}));
  await h.start();
  const bad: Record<string, unknown>[] = [
    { entity: "robots", query: "x" }, { entity: "people" }, { entity: "people", query: "  " },
    { entity: "people", query: "x", urls: ["https://a.test/"] }, { entity: "companies", query: "x", domains: ["a.test"] },
  ];
  for (const args of bad) await assert.rejects(h.run("web_search", args), undefined, JSON.stringify(args));
  assert.equal(h.calls.length, 0);
});

test("entity lookup uses the synchronous native route, keeps the full artifact, and hides the set ID without any group setup", async t => {
  const entities = Array.from({ length: 100 }, (_, i) => ({ name: `Company ${i}`, url: `https://c${i}.example/`, description: `Makes widget number ${i}. ${"x".repeat(400)}` }));
  const h = await setup(t, () => json({ entities, entity_set_id: "entity_set_secret_9" }));
  await h.start();
  const out = await h.call("web_search", { entity: "companies", query: "widget makers in Ohio" });
  assert.deepEqual(h.calls.map(c => `${c.method} ${c.path}`), ["POST /v1beta/findall/entity-search"]);
  assert.deepEqual(h.calls[0]!.body, { entity_type: "companies", objective: "widget makers in Ohio" }, "no count knob; backend default applies");
  assert.match(h.calls[0]!.beta ?? "", /findall-2025-09-15/);
  assert.match(out.text, /^100 companies found for: widget makers in Ohio/);
  assert.match(out.text, /- Company 0 — https:\/\/c0\.example\/\n {2}Makes widget number 0\./);
  assert.doesNotMatch(out.text, /entity_set_secret_9|entity_set_id/);
  assert.ok(out.text.length <= 24_000, "bounded preview");
  assert.match(out.text, /more entities are only in the saved file/);
  const saved = JSON.parse(await readFile(out.details.artifact, "utf8"));
  assert.equal(saved.entities.length, 100, "the full result is preserved");
  assert.equal(saved.entity_set_id, "entity_set_secret_9", "raw artifact keeps diagnostics");
  assert.equal(out.details.count, 100);
});

/** Loads this checkout's entry directly (not through Pi's loader) so tests can inject store faults in the shared module instance. */
async function direct(t: Parameters<typeof setup>[0], handler: Parameters<typeof setup>[1], options: Parameters<typeof setup>[2] = {}) {
  const h = await setup(t, handler, { ...options, direct: true });
  return h;
}

function patch(t: { after(fn: () => void): void }, name: string, replacement: (this: any, original: any, ...args: any[]) => unknown) {
  const proto = WebhookInbox.prototype as any;
  const original = proto[name];
  proto[name] = function (this: any, ...args: any[]) { return replacement.call(this, original.bind(this), ...args); };
  t.after(() => { proto[name] = original; });
}
const tmp = async (label: string) => join((await import("node:os")).tmpdir(), `wt-${label}-${process.pid}-${Date.now()}`);

test("effort policy: exact backend choice per level for discovery, conversation and deep research; low by default; no escalation", async t => {
  answers = 0;
  const base = deepHost();
  const h = await setup(t, call => call.path === "/v1/search" ? json(searchPayload) : call.path === "/v1/responses" ? responsesReply(call) : base(call),
    { webhookDir: await tmp("effort"), webhookUrl: CALLBACK });
  await h.start();
  const modes: string[] = [], levels: string[] = [], processors: string[] = [];
  for (const effort of [undefined, "low", "medium", "high"]) {
    const args = effort ? { effort } : {};
    await h.call("web_search", { query: "q", ...args });
    await h.call("interactive_search", { question: "q", ...args });
    await h.call("deep_search", { query: "q", ...args });
  }
  for (const c of h.calls) {
    if (c.path === "/v1/search") modes.push(c.body.mode);
    if (c.path === "/v1/responses") levels.push(c.body.reasoning.effort);
    if (/\/runs$/.test(c.path)) processors.push(c.body.inputs[0].processor);
  }
  assert.deepEqual(modes, ["fast", "fast", "basic", "advanced"]);
  assert.deepEqual(levels, ["low", "low", "medium", "high"]);
  assert.deepEqual(processors, ["core", "core", "pro", "ultra2x"]);
  assert.equal(h.calls.filter(c => c.path === "/v1/search").length, 4, "one request per call: no automatic escalation");
  for (const c of h.calls) assert.doesNotMatch(JSON.stringify(c.body), /turbo|"ultra"|"base"/);
  const cost = JSON.stringify([...h.tools.values()].map((tool: any) => tool.promptGuidelines));
  for (const price of ["$0.025", "$0.10", "$0.60", "$0.01,", "$0.05,", "$0.25", "$0.001", "$0.005"]) assert.ok(cost.includes(price), price);
});

test("a stale runtime never notifies after a session switch during the lookup, and the delivery stays unacknowledged", async t => {
  const dir = await tmp("stale");
  const h = await direct(t, deepHost(), { webhookDir: dir, webhookUrl: CALLBACK });
  await mkdir(dir, { recursive: true });
  const db = await store(dir);
  t.after(() => db.close());
  const seed = async (id: string) => {
    const ref = `research_${id}-0000-0000-0000-000000000000`;
    const now = Date.now();
    await db.createResearch({ reference: ref, session_id: "session-a", group_id: "tg_1", query: "q", effort: "low", status: "dispatching", artifact_dir: h.dir, created_at: now, updated_at: now });
    await db.acceptResearch(ref, `run_${id}`);
    await db.put({ webhook_id: `wh_${id}`, event: {}, resource_id: `run_${id}`, kind: "task" });
    await db.markHandled(`wh_${id}`, { resource_id: `run_${id}`, kind: "task", result_artifact: join(h.dir, "r.json") });
    return ref;
  };
  await seed("aaaaaaaa");
  let reached!: () => void;
  const lookup = new Promise<void>(r => { reached = r; });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  patch(t, "researchForRun", async function (original, id) { reached(); await gate; return original(id); });
  const starting = h.start();
  await lookup;
  h.ctx.sessionManager.getSessionId = () => "session-b"; // the session switched mid-lookup
  release();
  await starting;
  assert.equal(h.sent.length, 0);
  assert.equal(h.entries.length, 0);
  assert.equal((await db.listHandledUnnotified()).length, 1, "not acknowledged");
});

test("notifications use the persisted research status and hide the remote run ID", async t => {
  const dir = await tmp("notify");
  const h = await setup(t, deepHost(), { webhookDir: dir, webhookUrl: CALLBACK });
  await mkdir(dir, { recursive: true });
  const db = await store(dir);
  t.after(() => db.close());
  const now = Date.now();
  for (const [id, status] of [["bbbbbbbb", "cancelled"], ["cccccccc", "action_required"]] as const) {
    const ref = `research_${id}-0000-0000-0000-000000000000`;
    await db.createResearch({ reference: ref, session_id: "session-a", group_id: "tg_1", query: "q", effort: "low", status: "dispatching", artifact_dir: h.dir, created_at: now, updated_at: now });
    await db.acceptResearch(ref, `run_${id}`);
    await db.updateResearch(ref, { status });
    await db.put({ webhook_id: `wh_${id}`, event: {}, resource_id: `run_${id}`, kind: "task" });
    await db.markHandled(`wh_${id}`, { resource_id: `run_${id}`, kind: "task", terminal_failure: true });
  }
  await h.start();
  const details = h.entries.map(e => (e.data as any).status).sort();
  assert.deepEqual(details, ["action_required", "cancelled"]);
  const text = h.sent.map(m => JSON.stringify(m.message)).join("\n");
  assert.match(text, /cancelled/);
  assert.doesNotMatch(text, /run_bbbbbbbb|run_cccccccc/);
  assert.equal((await db.listHandledUnnotified()).length, 0);
});

test("a failure while recording a later brief keeps earlier references and sends nothing further", async t => {
  const h = await direct(t, deepHost(), { webhookDir: await tmp("batch"), webhookUrl: CALLBACK });
  await h.start();
  let created = 0;
  patch(t, "createResearch", function (original, record) {
    if (++created === 2) return Promise.reject(new Error("disk full"));
    return original(record);
  });
  const out = await h.call("deep_search", { query: ["a", "b", "c"] });
  assert.equal(out.details.references.length, 1);
  assert.match(out.text, /Brief 1: research_[0-9a-f-]{36} — accepted/);
  assert.match(out.text, /Brief 2: not accepted: disk full/);
  assert.match(out.text, /Brief 3: not submitted/);
  assert.equal(posts(h.calls, /\/runs$/).length, 1);
});

test("stopping waits for an in-flight conversational request to persist its uncertain state before the store closes", async t => {
  const h = await setup(t, call => new Promise<Response>((_, reject) => call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  await h.start();
  const inflight = h.run("interactive_search", { question: "slow" }).catch(e => e);
  while (h.calls.length === 0) await new Promise(r => setTimeout(r, 10));
  await h.stop();
  const err: any = await inflight;
  const ref = /conversation_[0-9a-f-]{36}/.exec(err.message)?.[0];
  assert.ok(ref, String(err.message));
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  assert.equal((await db.getConversation(ref))!.status, "uncertain", "persisted before stop returned");
  await assert.rejects(h.run("interactive_search", { question: "after" }), /not started|unavailable|stopping/);
  assert.equal(h.calls.length, 1);
});

test("if local acceptance fails after the service accepted a run, the raw acceptance file stays recoverable and nothing is resubmitted", async t => {
  const h = await direct(t, deepHost(), { webhookDir: await tmp("accept"), webhookUrl: CALLBACK });
  await h.start();
  patch(t, "acceptResearch", () => Promise.reject(new Error("locked while binding run_1")));
  const err: any = await h.run("deep_search", { query: "one" }).catch(e => e);
  assert.match(err.message, /uncertain/);
  assert.doesNotMatch(err.message, /run_1/);
  assert.equal(posts(h.calls, /\/runs$/).length, 1);
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const record = (await db.getResearch(/research_[0-9a-f-]{36}/.exec(err.message)![0]))!;
  assert.equal(record.status, "uncertain");
  assert.equal(record.run_id, undefined, "identity is bound only by acceptResearch");
  assert.doesNotMatch(record.error ?? "", /run_1/);
  assert.ok(record.creation_artifact);
  assert.match(await readFile(record.creation_artifact!, "utf8"), /"run_1"/, "raw acceptance retains the identity for recovery");
});

test("saved research without answer content shows a notice, never raw control data, and cannot ground a follow-up", async t => {
  const h = await setup(t, deepHost(), { webhookDir: await tmp("nocontent"), webhookUrl: CALLBACK });
  await h.start();
  const ref = (await h.call("deep_search", { query: "original" })).details.references[0] as string;
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const artifact = join(h.dir, "bare.json");
  await writeFile(artifact, JSON.stringify({ run: { run_id: "run_secret", interaction_id: "int_secret", metadata: { webtasks_ref: ref } }, output: { type: "text" } }));
  await db.updateResearch(ref, { status: "completed", artifact });
  const read = await h.call("deep_search", { research: ref });
  assert.match(read.text, /no readable answer content/);
  assert.match(read.text, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(read.text, /run_secret|int_secret/);
  const adds = posts(h.calls, /\/runs$/).length;
  await assert.rejects(h.run("deep_search", { query: "more", research: ref }), /no readable answer/);
  assert.equal(posts(h.calls, /\/runs$/).length, adds, "rejected before the paid call");
});

const extractPayload = { extract_id: "extract_1", session_id: "provider_ctx_1", results: [{ url: "https://example.org/a", title: "A", excerpts: ["beta fact"], full_content: "full beta" }] };
function retrievalHost(overrides: Record<string, (call: Call) => Response> = {}) {
  return (call: Call) => overrides[call.path]?.(call)
    ?? (call.path === "/v1/search" ? json({ ...searchPayload, session_id: "provider_ctx_1" })
      : call.path === "/v1/extract" ? json(extractPayload)
      : call.path === "/v1beta/findall/entity-search" ? json({ entities: [{ name: "Acme", url: "https://acme.example/", description: "Widgets" }], entity_set_id: "entity_set_7" })
      : json({ error: `unexpected ${call.path}` }, 500));
}

test("every session start records local metadata in the store without any remote request; reload keeps the ID, new sessions get their own", async t => {
  for (const configured of [false, true]) {
    const dir = configured ? await tmp("meta") : undefined;
    const h = await setup(t, retrievalHost(), { webhookDir: dir });
    if (dir) await mkdir(dir, { recursive: true });
    await h.start();
    const db = await store(h.inboxDir);
    t.after(() => db.close());
    const first = (await db.getSession("session-a"))!;
    assert.equal(first.cwd, h.dir);
    assert.equal(first.artifact_dir, join(h.dir, "agent", "webtasks", "results"));
    assert.equal(await db.getSessionGroup("session-a"), undefined, "no group row before the first deep submission");
    await h.stop();
    await (await h.instance("session-a")).start();
    await (await h.instance("session-b")).start(); // a new or forked session
    assert.ok(await db.getSession("session-a"));
    assert.equal((await db.getSession("session-b"))!.session_id, "session-b");
    assert.equal(h.calls.length, 0, "startup sends nothing to the provider");
  }
});

test("Search and Extract carry the Pi session ID as their context; Entity does not; the model never sees the field", async t => {
  const h = await setup(t, retrievalHost());
  await h.start();
  await h.call("web_search", { query: "alpha" });
  await h.call("web_search", { urls: ["https://example.org/a"] });
  await h.call("web_search", { entity: "people", query: "x" });
  assert.equal(h.calls[0]!.body.session_id, "session-a");
  assert.equal(h.calls[1]!.body.session_id, "session-a");
  assert.equal("session_id" in h.calls[2]!.body, false, "the pinned entity route takes no session context");
  const reloaded = await h.instance("session-a");
  await reloaded.start();
  await reloaded.call("web_search", { query: "again" });
  const forked = await h.instance("session-fork");
  await forked.start();
  await forked.call("web_search", { query: "again" });
  assert.equal(h.calls[3]!.body.session_id, "session-a", "same Pi ID after reload");
  assert.equal(h.calls[4]!.body.session_id, "session-fork");
  assert.doesNotMatch(JSON.stringify([...h.tools.values()].map((tool: any) => tool.parameters)), /session/i);
  const tooLong = await h.instance("x".repeat(1001));
  await tooLong.start();
  await tooLong.call("web_search", { query: "q" });
  assert.equal("session_id" in h.calls.at(-1)!.body, false, "an unacceptable ID is omitted, not sent");
});

test("each retrieval request is logged with a bounded summary, bounded raw identifiers and its artifact, and no payload", async t => {
  const h = await setup(t, retrievalHost({ "/v1/extract": () => json({ ...extractPayload, session_id: "s".repeat(300) }) }));
  await h.start();
  const long = "q".repeat(700);
  const s = await h.call("web_search", { query: long });
  const e = await h.call("web_search", { urls: ["https://example.org/a"] });
  const n = await h.call("web_search", { entity: "companies", query: "widget makers" });
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const rows = await db.activitiesForSession("session-a");
  assert.deepEqual(rows.map(r => r.kind).sort(), ["entity", "extract", "search"]);
  const by = Object.fromEntries(rows.map(r => [r.kind, r]));
  assert.equal(by.search!.query!.length, 500);
  assert.deepEqual(by.search!.provider_ids, { session_id: "provider_ctx_1", search_id: "search_secret_1" });
  assert.deepEqual(by.extract!.provider_ids, { extract_id: "extract_1" }, "an over-long identifier is not stored");
  assert.deepEqual(by.entity!.provider_ids, { entity_set_id: "entity_set_7" });
  assert.equal(by.search!.artifact, s.details.artifact);
  assert.equal(by.extract!.artifact, e.details.artifact);
  assert.equal(by.entity!.artifact, n.details.artifact);
  for (const row of rows) {
    assert.equal(row.status, "completed");
    assert.match(row.reference, /^activity_[0-9a-f-]{36}$/);
    assert.ok(JSON.stringify(row).length < 1_000, "a small log row, not a payload");
    assert.doesNotMatch(JSON.stringify(row), /offline-only|alpha fact|beta fact/);
  }
  assert.match(await readFile(by.search!.artifact!, "utf8"), /alpha fact/, "the payload stays in the file");
  assert.doesNotMatch(s.text + e.text + n.text, /search_secret_1|extract_1|entity_set_7|provider_ctx_1/);
});

test("failed and uncertain requests are logged; an unrecordable log is reported, not claimed", async t => {
  let status = 422;
  const h = await direct(t, retrievalHost({ "/v1/search": () => json({ error: "no" }, status) }));
  await h.start();
  await assert.rejects(h.run("web_search", { query: "one" }));
  status = 503;
  await assert.rejects(h.run("web_search", { query: "two" }));
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const rows = await db.activitiesForSession("session-a");
  assert.deepEqual(rows.map(r => r.status).sort(), ["failed", "uncertain"]);
  patch(t, "saveSearchActivity", () => Promise.reject(new Error("disk full")));
  const ok = await h.call("web_search", { urls: ["https://example.org/a"] });
  assert.match(ok.text, /request log could not be recorded: disk full/);
  assert.equal((await db.activitiesForSession("session-a")).length, 2, "nothing was claimed as logged");
});

test("stopping waits for an in-flight retrieval to persist its uncertain log before the store closes", async t => {
  const h = await setup(t, call => new Promise<Response>((_, reject) => call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  await h.start();
  const inflight = h.run("web_search", { query: "slow" }).catch(e => e);
  while (h.calls.length === 0) await new Promise(r => setTimeout(r, 10));
  await h.stop();
  assert.ok((await inflight) instanceof Error);
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const rows = await db.activitiesForSession("session-a");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "uncertain");
});

test("follow-ups chain through the explicit parent's own interaction; branches and independent briefs inherit nothing", async t => {
  const h = await setup(t, deepHost(), { webhookDir: await tmp("chain"), webhookUrl: CALLBACK });
  await h.start();
  const db = await store(h.inboxDir);
  t.after(() => db.close());
  const complete = async (ref: string, interaction: string, how: "record" | "artifact") => {
    const artifact = join(h.dir, `${ref}.json`);
    await writeFile(artifact, JSON.stringify({ run: how === "artifact" ? { interaction_id: interaction } : {}, output: { content: `Finding of ${ref}` } }));
    await db.updateResearch(ref, { status: "completed", artifact, ...(how === "record" ? { interaction_id: interaction } : {}) });
  };
  const submit = async (args: Record<string, unknown>) => {
    const out = await h.call("deep_search", args);
    const sent = posts(h.calls, /\/runs$/).at(-1)!.body.inputs[0];
    const ref = out.details.references[0] as string;
    return { ref, sent, record: (await db.getResearch(ref))! };
  };
  const a = await submit({ query: "A" });
  assert.equal(a.sent.previous_interaction_id, undefined);
  assert.equal(a.record.parent, undefined);
  await complete(a.ref, "int_A", "record");
  const b = await submit({ query: "B", research: a.ref });
  assert.equal(b.sent.previous_interaction_id, "int_A");
  assert.equal(b.record.parent, a.ref);
  await complete(b.ref, "int_B", "artifact");
  const c = await submit({ query: "C", research: b.ref });
  assert.equal(c.sent.previous_interaction_id, "int_B", "B's own interaction, not A's");
  assert.equal(c.record.parent, b.ref);
  const d = await submit({ query: "D", research: a.ref });
  assert.equal(d.sent.previous_interaction_id, "int_A", "a branch from A keeps A's interaction after B and C exist");
  assert.equal(d.record.parent, a.ref);
  const e = await submit({ query: "E" });
  assert.equal(e.sent.previous_interaction_id, undefined, "same group, no inherited context");
  assert.equal(e.record.parent, undefined);
  for (const sent of [a.sent, b.sent, c.sent, d.sent, e.sent]) assert.doesNotMatch(JSON.stringify(sent.metadata), /int_/);
  // Without a known interaction the saved findings alone ground the brief.
  const bare = join(h.dir, "bare.json");
  await writeFile(bare, JSON.stringify({ output: { content: "Finding without interaction" } }));
  await db.updateResearch(e.ref, { status: "completed", artifact: bare });
  const f = await submit({ query: "F", research: e.ref });
  assert.equal(f.sent.previous_interaction_id, undefined);
  assert.match(f.sent.input, /Finding without interaction/);
  assert.equal(f.record.parent, e.ref);
});
