import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup, type Call } from "./helpers/test-host.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const quietStream = () => new Response("", { headers: { "Content-Type": "text/event-stream" } });
const searchPayload = { search_id: "search_login_1", results: [{ url: "https://example.org/a", title: "A", excerpts: ["alpha fact"], full_content: null }] };
const keyOf = (call: Call) => call.headers.get("x-api-key");
const NO_KEY_HINT = /\/login/;

/** Remove every key source the process could read, so the test controls the only key. */
function withoutEnvKeys() {
  delete process.env._PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
}

function deepHost() {
  let runs = 0;
  return async (call: Call) => {
    if (call.path === "/v1/tasks/groups" && call.method === "POST") return json({ taskgroup_id: "tg_1", status: { is_active: false } });
    if (/\/runs$/.test(call.path) && call.method === "POST") return json({ run_ids: [`run_${++runs}`], status: { is_active: true } });
    if (call.method === "GET" && /^\/v1\/tasks\/groups\/tg_1\/(events|runs)$/.test(call.path)) return quietStream();
    if (/^\/v1\/tasks\/runs\/run_\d+$/.test(call.path)) return json({ run_id: "run_1", status: "running" });
    return json({ error: `unexpected ${call.method} ${call.path}` }, 500);
  };
}

/** An interaction whose prompt answers with `answer`, or rejects when it is an Error (a cancel). */
function interactionAnswering(answer: string | Error, log: string[] = [], events: unknown[] = [], prompts: unknown[] = []) {
  return {
    signal: new AbortController().signal,
    notify(event: unknown) { log.push("notify"); events.push(event); },
    async prompt(prompt: unknown) {
      log.push("prompt"); prompts.push(prompt);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else out.push(path);
  }
  return out;
}

test("Parallel registers as a provider with no models and only an API-key login", async t => {
  const h = await setup(t, () => json({}));
  assert.equal(h.nativeProviders.length, 1, "exactly one provider is registered");
  const [provider] = h.nativeProviders;
  assert.equal(provider.id, "parallel");
  assert.equal(provider.name, "Parallel");
  assert.deepEqual(provider.getModels(), [], "no models, so no model-picker entries");
  assert.equal(typeof provider.auth.apiKey.login, "function");
  assert.equal(provider.auth.oauth, undefined);
});

test("login shows the key page, then asks for a secret, and returns the trimmed key", async t => {
  const h = await setup(t, () => json({}));
  const [provider] = h.nativeProviders;
  const log: string[] = [], events: any[] = [], prompts: any[] = [];
  const credential = await provider.auth.apiKey.login(interactionAnswering("  synthetic-login-key  ", log, events, prompts));
  assert.deepEqual(log, ["notify", "prompt"], "the link is shown before the prompt");
  assert.equal(events[0].type, "auth_url");
  assert.equal(events[0].url, "https://platform.parallel.ai/settings?tab=api-key");
  assert.deepEqual(prompts, [{ type: "secret", message: "Parallel API key" }]);
  assert.deepEqual(credential, { type: "api_key", key: "synthetic-login-key" });
});

test("an empty or cancelled entry stores nothing", async t => {
  const h = await setup(t, () => json({}));
  const [provider] = h.nativeProviders;
  for (const entry of ["", "   "]) {
    await assert.rejects(provider.auth.apiKey.login(interactionAnswering(entry)), /Nothing was saved/);
  }
  const cancel = new Error("Login cancelled");
  await assert.rejects(provider.auth.apiKey.login(interactionAnswering(cancel)), (err: unknown) => err === cancel);
});

test("with a stored key the tool runs, and the request carries that key", async t => {
  const h = await setup(t, () => json(searchPayload));
  withoutEnvKeys();
  h.credentials.parallel = { type: "api_key", key: "stored-synthetic-key" };
  await h.start();
  const found = await h.call("web_search", { query: "alpha fact" });
  assert.match(found.text, /alpha fact/);
  assert.equal(keyOf(h.calls[0]!), "stored-synthetic-key");
});

test("with no key from any source, the call fails with the /login hint before any request", async t => {
  const h = await setup(t, () => json(searchPayload));
  withoutEnvKeys();
  await h.start();
  for (const [name, args] of [["web_search", { query: "alpha fact" }], ["deep_search", { query: "one" }]] as const) {
    await assert.rejects(h.run(name, { ...args }), (err: any) =>
      NO_KEY_HINT.test(err.message) && /_PARALLEL_API_KEY/.test(err.message), name);
  }
  assert.equal(h.calls.length, 0, "no request was made");
});

test("a login mid-session works on the next call; after logout the old key is not reused", async t => {
  const h = await setup(t, () => json(searchPayload));
  withoutEnvKeys();
  await h.start();
  await assert.rejects(h.call("web_search", { query: "alpha fact" }), NO_KEY_HINT);
  h.credentials.parallel = { type: "api_key", key: "first-synthetic-key" };
  await h.call("web_search", { query: "alpha fact" });
  assert.equal(keyOf(h.calls.at(-1)!), "first-synthetic-key");
  delete h.credentials.parallel;
  await assert.rejects(h.call("web_search", { query: "alpha fact" }), NO_KEY_HINT, "logout leaves no key");
  assert.equal(h.calls.length, 1, "the call after logout made no request");
});

test("the stored key is used for the deep_search result fetch too", async t => {
  const h = await setup(t, deepHost(), { webhookDir: join(tmpdir(), `wt-login-${process.pid}-${Date.now()}`) });
  withoutEnvKeys();
  h.credentials.parallel = { type: "api_key", key: "stored-synthetic-key" };
  await h.start();
  const first = await h.call("deep_search", { query: "one" });
  await h.call("deep_search", { research: first.details.references[0] });
  assert.ok(h.calls.some(c => c.path === "/v1/tasks/runs/run_1"), "the result fetch reached the run endpoint");
  for (const call of h.calls) assert.equal(keyOf(call), "stored-synthetic-key", `${call.method} ${call.path}`);
});

test("the key never appears in tool text, details, progress, artifacts, or errors", async t => {
  const SECRET = "login-secret-7f3a9c";
  let deny = false;
  const deep = deepHost();
  const h = await setup(t, async call => {
    if (deny) return json({ error: "denied" }, 401);
    if (call.path === "/v1/search") return json(searchPayload);
    return deep(call);
  }, { webhookDir: join(tmpdir(), `wt-secret-${process.pid}-${Date.now()}`) });
  withoutEnvKeys();
  h.credentials.parallel = { type: "api_key", key: SECRET };
  await h.start();
  const found = await h.call("web_search", { query: "alpha fact" });
  const submitted = await h.call("deep_search", { query: "one" });
  const read = await h.call("deep_search", { research: submitted.details.references[0] });
  for (const out of [found, submitted, read]) {
    assert.doesNotMatch(out.text, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(out.details), new RegExp(SECRET));
  }
  assert.doesNotMatch(h.progress.join("\n"), new RegExp(SECRET));

  deny = true;
  const err = await h.run("web_search", { query: "alpha fact" }).then(() => undefined, (e: unknown) => e as Error);
  assert.ok(err instanceof Error, "a rejected key surfaces as an error");
  assert.doesNotMatch(`${err.message}\n${err.stack ?? ""}`, new RegExp(SECRET));

  const files = await filesUnder(h.dir);
  assert.ok(files.some(f => f.includes(join("agent", "webtasks", "results"))), "artifacts were written");
  for (const file of files) {
    assert.equal((await readFile(file)).includes(SECRET), false, `${file} contains the key`);
  }
});
