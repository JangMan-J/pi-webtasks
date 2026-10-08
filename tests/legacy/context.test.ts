import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactError, PREVIEW_LIMIT, preview, researchOutput, redact } from "../../src/results.ts";
import { context, loadTools, setup } from "../helpers/test-host.ts";

const huge = '🦄\n"\\'.repeat(20_000);
const source = { url: "https://example.com/source", title: "Source", excerpts: [huge], full_content: huge };
const data = { search_id: "s1", session_id: "session", results: [source, { ...source, url: "https://example.com/second" }], warnings: [{ message: huge }], usage: [{ name: "search", count: 1 }] };

function bounded(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  assert.ok(text.length <= PREVIEW_LIMIT, `${text.length} characters`);
  assert.equal(text.isWellFormed(), true);
  return text;
}

test("artifacts preserve complete data, paths, permissions, concurrency, local reads, overwrite and failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parallel-context-"));
  try {
    const opts = { cwd: dir, artifactDir: join(dir, "results") };
    const receipts = await Promise.all(Array.from({ length: 8 }, () => researchOutput(data, {}, opts)));
    assert.equal(new Set(receipts.map(r => r.artifact)).size, 8);
    for (const r of receipts) {
      bounded(r);
      assert.deepEqual(JSON.parse(await readFile(r.artifact!, "utf8")), data);
      assert.equal((await stat(r.artifact!)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(opts.artifactDir)).mode & 0o777, 0o700);
    const explicit = await researchOutput(data, { output_path: "@saved.json", return_mode: "file" }, opts);
    assert.equal(explicit.artifact, join(dir, "saved.json"));
    assert.equal("preview" in explicit, false);
    const full = JSON.parse(await readFile(explicit.artifact!, "utf8"));
    assert.equal(full.results[0].full_content, huge);
    await assert.rejects(researchOutput(data, { output_path: "saved.json", run_id: "keep-me" }, opts), err => {
      assert.ok(err instanceof ArtifactError);
      const failed = JSON.parse(err.message);
      bounded(failed);
      assert.equal(failed.control.run_id, "keep-me");
      assert.equal(failed.artifact, null);
      assert.match(err.message, /EEXIST/);
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(explicit.artifact!, "utf8")), data);
    await researchOutput({ replaced: true }, { output_path: "saved.json", overwrite: true }, opts);
    assert.deepEqual(JSON.parse(await readFile(explicit.artifact!, "utf8")), { replaced: true });
    await assert.rejects(researchOutput(data, {}, { ...opts, artifactDir: join(explicit.artifact!, "blocked") }), /ENOTDIR/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("previews retain ordered URLs, IDs, citations, counts and bounded diagnostics; file mode has no bodies", () => {
  const p = preview(data, "/saved.json");
  bounded(p);
  assert.deepEqual((p.preview as any).results.map((r: any) => r.url), data.results.map(r => r.url));
  assert.equal((p.control as any).session_id, "session");
  assert.equal((p.counts as any).warnings, 1);
  const output = { content: huge, basis: [{ field: "output", reasoning: huge, citations: [{ url: source.url, excerpts: [huge] }] }] };
  const task = { run: { run_id: "run", interaction_id: "interaction", status: "completed" }, output };
  const t = preview(task, "/saved.json");
  assert.equal((t.control as any)["run.interaction_id"], "interaction");
  assert.ok(bounded(t).includes(source.url));
  for (const shape of [task, { response: { id: "response", previous_response_id: "previous", output: [{ content: [{ text: huge, annotations: [{ type: "url_citation", url: source.url }] }] }] } }, { events: [{ type: "response.created", response: { id: "stream-response" } }, { type: "error", error: { message: huge } }], last_event_id: "last" }, { results: [{ id: "memory", input_excerpt: huge, output_excerpt: huge }], next_cursor: "next" }]) {
    bounded(preview(shape, "/saved.json"));
    const file = preview(shape, "/saved.json", { return_mode: "file" });
    assert.equal("preview" in file, false);
    bounded(file);
  }
  const ids = ["run1", "run2", "run3", "run4", "run5", "run6"];
  assert.deepEqual((preview({ run_ids: ids, run_cursor: "run-cursor", event_cursor: "event-cursor" }, "/saved.json").control as any).run_ids, ids);
  const stream = preview({ events: [{ response: { id: "stream-response" } }], last_event_id: "resume" }, "/saved.json", { return_mode: "file" });
  assert.equal((stream.control as any)["event.response.id"], "stream-response");
  assert.equal((stream.control as any).last_event_id, "resume");
  for (const shape of [null, [], { results: [], errors: [] }, { strange: { nested: huge } }, { errors: Array.from({ length: 10_000 }, () => ({ message: huge.slice(0, 20) })), cursor: "keep" }, { run_id: huge, next_cursor: "short", warnings: [huge] }]) bounded(preview(shape, "/saved.json"));
  assert.equal((preview({ errors: Array(100).fill("failed") }, "/saved.json").counts as any).errors, 100);
  assert.equal((preview({ unexpected: huge }, "/saved.json").preview as any).fields.unexpected.type, "string");
  const protectedData = { api_key: "secret", nested: { raw_api_key: "secret", authorization: "secret", refresh_token: "secret" }, mcp_servers: [{ name: "service", url: "https://example.com/mcp", headers: { "Custom-Credential": "secret" } }] };
  assert.equal(JSON.stringify(redact(protectedData)).includes("secret"), false);
});

test("oversized validation fields retain useful diagnostics within the receipt ceiling", () => {
  const errors = Array.from({ length: 30 }, () => ({
    loc: Array(12).fill("field".repeat(100)), msg: "🦄".repeat(500), type: "missing".repeat(200), input: huge,
  }));
  const receipt = preview({ error: { status: 422, error: { detail: { errors } } } }, "/saved.json", { return_mode: "file" });
  const diagnostics = (receipt.diagnostics as any).error.validation_errors;
  assert.ok(diagnostics.length > 0 && diagnostics.length <= 5);
  assert.ok(diagnostics.every((error: any) => !("input" in error)));
  bounded(receipt);
});

test("offline fixture restores globals and removes artifacts after a failed request", async t => {
  const envObject = process.env;
  const env = { ...process.env };
  const home = homedir();
  const fetch = globalThis.fetch;
  let dir = "";
  await t.test("failure through the registered tool", async child => {
    const h = await setup(child, () => new Response(JSON.stringify({ message: "fixture failure" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }));
    dir = h.dir;
    await assert.rejects(h.execute("search", { search_queries: ["fixture cleanup"] }), /fixture failure/);
    assert.equal(h.calls.length, 1);
  });
  assert.ok(process.env === envObject, "Preserve Node's native environment object");
  assert.equal(Object.keys(process.env).length, Object.keys(env).length);
  assert.ok(Object.entries(env).every(([key, value]) => process.env[key] === value), "Restore environment values without logging them");
  assert.equal(homedir(), home);
  assert.equal(globalThis.fetch, fetch);
  await assert.rejects(stat(dir), { code: "ENOENT" });
});

test("all registered actions use real SDK request paths with mocked HTTP; commands, account secrets and error paths", async t => {
    let nextStatus = 200;
    let nextData: any;
    let failResult = false;
    let interruptStream = false;
    let fixture: any = {};
    const h = await setup(t, ({ path, method, body }) => {
      const status = nextStatus; nextStatus = 200;
      const value = nextData ?? fixture; nextData = undefined;
      if (failResult && path.endsWith("/result")) {
        failResult = false;
        return new Response(JSON.stringify({ message: "result not ready" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (interruptStream && path.endsWith("/events")) {
        interruptStream = false;
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (sent) { controller.error(new Error("stream disconnected")); return; }
            sent = true;
            controller.enqueue(new TextEncoder().encode('data: {"event_id":"resume-after-error","run":{"run_id":"run","status":"running"}}\n\n'));
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (body?.stream) {
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "stream-response", status: "completed", output: [{ content: [{ text: "Answer", annotations: [{ url: source.url }] }] }] } })}\n\n`, { status, headers: { "Content-Type": "text/event-stream" } });
      }
      if (path.includes("/findall/") && path.endsWith("/result")) {
        return new Response(JSON.stringify({ run: { findall_id: "findall", status: { status: "completed", is_active: false } }, candidates: [] }), { status, headers: { "Content-Type": "application/json" } });
      }
      if (path.endsWith("/events") || path.endsWith("/runs") && method === "GET") {
        return new Response(`data: ${JSON.stringify({ event_id: "event", type: "task_run.state", run: { run_id: "run", status: "completed" }, output: { content: huge, basis: [] } })}\n\n`, { status, headers: { "Content-Type": "text/event-stream" } });
      }
      if (method === "DELETE" || path.endsWith("/trigger") || path.endsWith("/memory/clear") || path.endsWith("/memory/evict")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    });
    const { dir, tools, commands, calls, ctx, progress, execute } = h;
    await loadTools(); // Repeated loading stays inside the fixture's isolated HOME.
    const accountDir = join(dir, ".config/pi-parallelized");
    await mkdir(accountDir, { recursive: true });
    const accountPath = join(accountDir, "account.json");
    await writeFile(accountPath, JSON.stringify({ client_id: "client", access_token: "access", access_expires_at: 9e9, refresh_token: "refresh" }));
    // All nine tools are exposed by default, without the lazy activator.
    assert.equal(tools.size, 9);
    assert.equal(tools.has("parallel_tools"), false);
    assert.deepEqual([...commands.keys()].sort(), ["parallel-balance", "parallel-login", "parallel-logout", "parallel-webhook"]);
    for (const [name, definition] of tools as any) {
      assert.equal("return_mode" in definition.parameters.properties, name !== "parallel_account");
      if (name !== "parallel_account") assert.match(definition.promptGuidelines.join(" "), /24,000/);
    }
    const responsesTool: any = tools.get("parallel_responses");
    assert.match(responsesTool.description, /cited synthesized answer or research follow-up/);
    assert.doesNotMatch(responsesTool.promptGuidelines.join(" "), /one-shot/i);
    assert.match(responsesTool.promptGuidelines.join(" "), /previous_response_id/);
    assert.ok(responsesTool.parameters.properties.input.anyOf);
    const memoryTool: any = tools.get("parallel_memory");
    assert.equal(memoryTool.parameters.properties.query.maxLength, 500);
    assert.equal(memoryTool.parameters.properties.limit.maximum, 25);
    assert.equal(memoryTool.parameters.properties.memory_scope_key.pattern, "^[a-zA-Z0-9_-]+$");
    const cases: [string, any, string, string][] = [
      ["search", { search_queries: ["test search query"] }, "/v1/search", "POST"],
      ["extract", { urls: [source.url], full_content: true }, "/v1/extract", "POST"],
      ["responses", { input: "test" }, "/v1/responses", "POST"],
      ["responses", { input: [{ role: "user", content: "test" }], previous_response_id: "response-before" }, "/v1/responses", "POST"],
      ["responses", { input: "test", stream: true }, "/v1/responses", "POST"],
      ...["create", "status", "result", "events", "input"].map(action => ["task", { action, input: "test", processor: "lite", run_id: "run" }, action === "create" ? "/v1/tasks/runs" : `/v1/tasks/runs/run${action === "status" ? "" : `/${action}`}`, action === "create" ? "POST" : "GET"] as [string, any, string, string]),
      ...["create", "status", "add", "runs", "run", "events"].map(action => ["group", { action, taskgroup_id: "group", run_id: "run", inputs: JSON.stringify([{ input: "test", processor: "lite" }]) }, action === "create" ? "/v1/tasks/groups" : action === "run" ? "/v1/tasks/groups/group/runs/run" : `/v1/tasks/groups/group${["add", "runs"].includes(action) ? "/runs" : action === "events" ? "/events" : ""}`, ["create", "add"].includes(action) ? "POST" : "GET"] as [string, any, string, string]),
      ...["ingest", "preview", "create", "status", "result", "events", "enrich", "extend", "cancel", "schema", "entity_search"].map(action => ["findall", { action, objective: "test", entity_type: "companies", match_conditions: JSON.stringify([{ name: "test", description: "test" }]), findall_id: "findall", additional_match_limit: 1, output_schema: JSON.stringify({ type: "object", properties: { name: { type: "string" } } }) }, "findall", ""] as [string, any, string, string]),
      ...["create", "list", "get", "update", "cancel", "events", "trigger"].map(action => ["monitor", { action, query: "test", frequency: "1d", monitor_id: "monitor" }, "monitors", ""] as [string, any, string, string]),
      ...["retrieve", "evict", "clear"].map(action => ["memory", { action, memory_scope_key: "test-only", id: "run", kind: "task" }, `memory/${action}`, "POST"] as [string, any, string, string]),
      ...["balance", "add_credit", "list_apps", "create_app", "delete_app", "create_key", "delete_key"].map(action => ["account", { action, amount_cents: 1, idempotency_key: "offline-only", app_name: "test", app_id: "app", api_key_id: "key", api_key_name: "test", save_key_path: "test-key.json" }, "service/v1", ""] as [string, any, string, string]),
    ];
    fixture = { search_id: "search", session_id: "session", run_id: "run", interaction_id: "interaction", taskgroup_id: "group", findall_id: "findall", monitor_id: "monitor", status: "completed", results: [source], candidates: [], output_text: "Answer", output: [{ content: [{ text: "Answer", annotations: [{ url: source.url }] }] }], run_ids: ["run"], api_key_id: "key", raw_api_key: "fake-secret-never-leak", app_id: "app" };
    for (const [name, args, path, method] of cases) {
      const before = calls.length;
      if (name === "account") nextData = { api_key_id: "key", raw_api_key: "fake-secret-never-leak", app_id: "app", credit_balance_cents: 100 };
      const receipt = await execute(name, args);
      assert.ok(calls.length > before, `${name}.${args.action ?? "call"} made no request`);
      const call = calls.at(-1)!;
      assert.ok(call.path.includes(path), `${name}.${args.action}: ${call.path} vs ${path}`);
      if (method) assert.equal(call.method, method, `${name}.${args.action}`);
      if (name === "responses" && Array.isArray(args.input)) {
        assert.deepEqual(call.body.input, args.input);
        assert.equal(call.body.previous_response_id, "response-before");
      }
      assert.equal(JSON.stringify(receipt).includes("fake-secret"), false);
      if (name !== "account") assert.equal((await readFile(receipt.artifact, "utf8")).includes("fake-secret"), false);
    }
    const key = JSON.parse(await readFile(join(dir, "test-key.json"), "utf8"));
    assert.equal(key.raw_api_key, "fake-secret-never-leak");
    assert.equal((await stat(join(dir, "test-key.json"))).mode & 0o777, 0o600);
    assert.equal(progress.some(p => p.includes("🦄")), false);
    assert.ok(progress.every(p => "details" in JSON.parse(p)));
    const searchRequest = calls.find(c => c.path === "/v1/search")!;
    assert.equal(searchRequest.body.max_chars_total, 50_000);
    assert.equal(searchRequest.body.mode, "fast");
    const file = await execute("search", { search_queries: ["test search query"], return_mode: "file", output_path: "explicit.json", max_chars_total: 40000 });
    assert.equal(file.artifact, join(dir, "explicit.json"));
    assert.equal("preview" in file, false);
    assert.equal(calls.at(-1)!.body.max_chars_total, 40000);
    assert.equal("return_mode" in calls.at(-1)!.body, false);
    const beforeCollision = calls.length;
    await assert.rejects(execute("search", { search_queries: ["test search query"], output_path: "explicit.json" }), err => {
      bounded(JSON.parse((err as Error).message)); return true;
    });
    assert.equal(calls.length, beforeCollision + 1, "No repeated API call after save failure");
    nextStatus = 400;
    nextData = { error: { message: huge, api_key: "hidden-key" } };
    await assert.rejects(execute("search", { search_queries: ["test"] }), err => {
      assert.ok((err as Error).message.length <= PREVIEW_LIMIT);
      assert.equal((err as Error).message.includes("hidden-key"), false);
      return true;
    });
    nextData = { id: "empty-response", output: [] };
    await assert.rejects(execute("responses", { input: "test" }), /empty Responses answer/);
    failResult = true;
    const beforeWait = calls.length;
    const waiting = await execute("task", { action: "create", input: "test", processor: "lite", wait_seconds: 1 });
    assert.equal(calls.length, beforeWait + 3, "Create once, wait once, retrieve status once");
    assert.equal(waiting.control.timeout, true);
    assert.equal(waiting.control["run.run_id"], "run");
    interruptStream = true;
    try { await execute("task", { action: "events", run_id: "run" }); assert.fail("expected interrupted stream"); }
    catch (err) {
      const failure = JSON.parse((err as Error).message);
      bounded(failure);
      assert.equal(failure.control.last_event_id, "resume-after-error");
      assert.equal(failure.control.run_id, "run");
      const partial = JSON.parse(await readFile(failure.artifact, "utf8"));
      assert.equal(partial.events.length, 1);
      assert.match(JSON.stringify(partial.error), /stream disconnected/);
    }
    await execute("task", { action: "create", input: "test options", processor: "lite", source_policy: JSON.stringify({ include_domains: ["example.com"] }), previous_interaction_id: "prior", mcp_servers: JSON.stringify([{ name: "service", url: "https://example.com/mcp", headers: { Authorization: "dummy-secret" } }]), webhook_url: "https://example.com/hook", webhook_events: ["task_run.status"] });
    const optionsRequest = calls.at(-1)!.body;
    assert.equal(optionsRequest.previous_interaction_id, "prior");
    assert.deepEqual(optionsRequest.source_policy.include_domains, ["example.com"]);
    assert.equal(optionsRequest.mcp_servers[0].headers.Authorization, "dummy-secret");
    assert.deepEqual(optionsRequest.webhook, { url: "https://example.com/hook", event_types: ["task_run.status"] });
    assert.ok(!calls.at(-1)!.beta?.includes("webhook-2025-08-12"), "current webhooks do not require the old beta flag");
    nextData = { entity_type: "companies", match_conditions: [{ name: "test", description: "test" }], generator: "core" };
    await execute("findall", { action: "preview", objective: "test preview default" });
    assert.equal(calls.at(-1)!.body.generator, "preview", "Ingest recommendations must not upgrade preview to a paid full run");
    const beforeInvalid = calls.length;
    await assert.rejects(execute("extract", { urls: Array(21).fill(source.url) }), /max 20/);
    assert.equal(calls.length, beforeInvalid);
    await commands.get("parallel-balance").handler("", ctx);
    const beforeDecline = calls.length;
    const monitorTool: any = tools.get("parallel_monitor");
    await assert.rejects(monitorTool.execute("declined", { action: "create", query: "test", frequency: "1d" }, undefined, undefined, context(dir, async () => false)), /User declined/);
    assert.equal(calls.length, beforeDecline);
    // OAuth helpers use only the fake HOME and mocked HTTP. Never log out the real account.
    const ops = await import("../../src/ops.ts");
    fixture = { client_id: "new-client", device_code: "device", user_code: "user", verification_uri: "https://example.com/login", interval: 1, expires_in: 60, access_token: "fresh", refresh_token: "fresh-refresh" };
    await writeFile(accountPath, "{}");
    const login = await ops.beginDeviceLogin();
    assert.ok(calls.some(c => c.path.endsWith("/register")));
    await ops.pollDeviceLogin(login);
    const expired = JSON.parse(await readFile(accountPath, "utf8"));
    await writeFile(accountPath, JSON.stringify({ ...expired, access_expires_at: 1 }));
    assert.equal(await ops.getAccessToken(), "fresh");
    assert.equal(calls.at(-1)!.body.grant_type, "refresh_token");
    await commands.get("parallel-logout").handler("", ctx);
    assert.equal((await readdir(accountDir)).includes("account.json"), false);
});
