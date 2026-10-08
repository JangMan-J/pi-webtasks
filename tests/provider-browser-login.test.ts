import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { parallelProvider, PARALLEL_KEY_URL } from "../src/provider.ts";
import { PARALLEL_AUTHORIZE_URL, PARALLEL_TOKEN_URL } from "../src/parallel-oauth.ts";
import { setup, type Call } from "./helpers/test-host.ts";

const KEY = "synthetic-browser-key-4c1d";
const CODE = "synthetic-authorization-code-9e2b";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const searchPayload = { search_id: "search_browser_1", results: [{ url: "https://example.org/a", title: "A", excerpts: ["alpha fact"], full_content: null }] };
const keyOf = (call: Call) => call.headers.get("x-api-key");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A synthetic token endpoint. It records each request and replies with the configured body or status. */
function fakeToken(reply: { status?: number; body?: unknown; raw?: string } = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? { access_token: KEY }), {
      status: reply.status ?? 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { requests, fetch: fetchFn };
}

/**
 * One browser sign-in attempt. `interaction` records notifications and prompts. `paste` answers a manual_code
 * prompt, given the auth_url the flow notified.
 */
function startLogin(options: { token?: ReturnType<typeof fakeToken>; timeoutMs?: number; paste?: (authUrl: string) => string } = {}) {
  const token = options.token ?? fakeToken();
  const provider = parallelProvider({ fetch: token.fetch, callbackTimeoutMs: options.timeoutMs ?? 5_000 });
  const oauth = provider.auth.oauth!;
  const events: any[] = [];
  const prompts: any[] = [];
  const controller = new AbortController();
  const interaction = {
    signal: controller.signal,
    notify(event: unknown) { events.push(event); },
    async prompt(prompt: any) {
      prompts.push(prompt);
      const authUrl = events.find(e => e.type === "auth_url")?.url as string;
      if (!options.paste) throw new Error("no paste expected");
      return options.paste(authUrl);
    },
  };
  const done = oauth.login(interaction as any);
  // The flow can settle before a test attaches its assertion; observe here so that is not an unhandled rejection.
  done.catch(() => undefined);
  return { oauth, provider, events, prompts, controller, token, done };
}

const authUrlOf = (h: { events: any[] }) => until(() => h.events.find(e => e.type === "auth_url")?.url as string | undefined, "auth_url");
const redirectOf = (authUrl: string) => new URL(authUrl).searchParams.get("redirect_uri")!;
const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get("state")!;
const callbackWith = (authUrl: string, params: Record<string, string>, path = "/callback") => {
  const url = new URL(path, redirectOf(authUrl));
  url.search = new URLSearchParams(params).toString();
  return url.toString();
};
/** The synthetic browser: GET the callback address it was sent to. */
async function browse(url: string, method = "GET") {
  const res = await fetch(url, { method });
  return { status: res.status, body: await res.text() };
}
/** The honest callback: the code and the state from the authorize URL the browser was sent. */
const goodCallback = (authUrl: string) => callbackWith(authUrl, { code: CODE, state: stateOf(authUrl) });

/** Connect results: "connected", or the socket error code (ECONNREFUSED when nothing listens). */
function probe(host: string, port: number): Promise<string> {
  return new Promise(resolve => {
    const socket: Socket = connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
  });
}
const portOf = (redirect: string) => Number(new URL(redirect).port);
async function assertClosed(redirect: string) {
  assert.equal(await probe("127.0.0.1", portOf(redirect)), "ECONNREFUSED", "the listener is closed");
}

test("success stores an oauth credential, the key comes from toAuth, and the token request is exact", async () => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  const res = await browse(goodCallback(authUrl));
  assert.equal(res.status, 200);
  assert.match(res.body, /close this tab/);
  const credential = await h.done;
  assert.deepEqual(credential, { type: "oauth", access: KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(await h.oauth.toAuth(credential), { apiKey: KEY });
  assert.equal(h.token.requests.length, 1);
  const { url, init } = h.token.requests[0]!;
  assert.equal(url, PARALLEL_TOKEN_URL);
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(init.body as string);
  assert.deepEqual([...body.keys()].sort(), ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), CODE);
  assert.equal(body.get("redirect_uri"), redirectOf(authUrl));
  assert.equal(body.get("client_id"), "127.0.0.1");
  await assertClosed(redirectOf(authUrl));
});

test("the authorize URL has exactly the contract parameters, and the verifier matches the challenge", async () => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  const url = new URL(authUrl);
  assert.equal(url.origin + url.pathname, PARALLEL_AUTHORIZE_URL);
  assert.equal(PARALLEL_AUTHORIZE_URL, "https://platform.parallel.ai/getKeys/authorize");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"]);
  assert.equal(url.searchParams.get("client_id"), "127.0.0.1");
  assert.match(url.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "key:read");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("state")!, /^[A-Za-z0-9_-]{20,}$/);
  await browse(goodCallback(authUrl));
  await h.done;
  const verifier = new URLSearchParams(h.token.requests[0]!.init.body as string).get("code_verifier")!;
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), url.searchParams.get("code_challenge"));
});

test("a state mismatch is rejected and no token request is made", async () => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  const res = await browse(callbackWith(authUrl, { code: CODE, state: "not-the-state-value-123" }));
  assert.equal(res.status, 400);
  await assert.rejects(h.done, /state mismatch/);
  assert.equal(h.token.requests.length, 0);
  await assertClosed(redirectOf(authUrl));
});

test("a wrong path or method gets 404 and the flow keeps waiting for the real callback", async () => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  const other = await browse(callbackWith(authUrl, { code: CODE, state: stateOf(authUrl) }, "/other"));
  assert.equal(other.status, 404);
  const post = await browse(goodCallback(authUrl), "POST");
  assert.equal(post.status, 404);
  assert.equal(h.token.requests.length, 0, "no code was accepted from the wrong path or method");
  assert.equal(await probe("127.0.0.1", portOf(redirectOf(authUrl))), "connected", "still listening");
  assert.equal((await browse(goodCallback(authUrl))).status, 200);
  assert.deepEqual(await h.done, { type: "oauth", access: KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER });
});

test("a malformed HTTP target does not crash login or prevent a later valid callback", () => {
  // Isolate the process boundary: the regression was an uncaught exception in the HTTP handler.
  const source = new URL("../src/parallel-oauth.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { browserLogin } from ${JSON.stringify(source)};
    import { connect } from "node:net";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let notified;
    const notification = new Promise(resolve => { notified = resolve; });
    let tokenCalls = 0;
    const login = browserLogin({
      signal: controller.signal,
      notify: event => notified(event),
      async prompt() { throw new Error("No paste expected"); },
    }, {
      fetch: async () => {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: "synthetic-key" }));
      },
    });
    login.catch(() => {});
    try {
      const authorize = new URL((await notification).url);
      const redirect = new URL(authorize.searchParams.get("redirect_uri"));
      const response = await new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: Number(redirect.port) });
        let received = "";
        socket.on("data", chunk => { received += chunk; });
        socket.once("error", reject);
        socket.once("end", () => resolve(received));
        socket.once("connect", () => socket.write(
          "GET http://[ HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n"
        ));
      });
      const tokenCallsBefore = tokenCalls;
      redirect.search = new URLSearchParams({
        state: authorize.searchParams.get("state"), code: "synthetic-code",
      }).toString();
      const callback = await fetch(redirect);
      await callback.text();
      const credential = await login;
      console.log(JSON.stringify({
        malformedStatus: Number(response.split(" ")[1]),
        tokenCallsBefore, tokenCalls, hasKey: credential.access === "synthetic-key",
      }));
    } finally {
      controller.abort();
      await login.catch(() => {});
      clearTimeout(timer);
    }
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? "child failed"));
  assert.deepEqual(JSON.parse(result.stdout), {
    malformedStatus: 400, tokenCallsBefore: 0, tokenCalls: 1, hasKey: true,
  });
});

test("the error parameter fails the login with the provider's description", async () => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  const res = await browse(callbackWith(authUrl, { error: "access_denied", error_description: "User denied access", state: stateOf(authUrl) }));
  assert.equal(res.status, 400);
  await assert.rejects(h.done, /Parallel sign-in failed: User denied access/);
  assert.equal(h.token.requests.length, 0);
  await assertClosed(redirectOf(authUrl));
});

test("an empty, missing, or failed token response fails the login", async () => {
  const cases: [string, Parameters<typeof fakeToken>[0], RegExp][] = [
    ["empty access_token", { body: { access_token: "   " } }, /no access_token/],
    ["missing access_token", { body: { token_type: "bearer" } }, /no access_token/],
    ["HTTP 500", { status: 500, body: {} }, /HTTP 500/],
  ];
  for (const [label, reply, error] of cases) {
    const h = startLogin({ token: fakeToken(reply) });
    const authUrl = await authUrlOf(h);
    await browse(goodCallback(authUrl));
    await assert.rejects(h.done, error, label);
    await assertClosed(redirectOf(authUrl));
  }
});

test("after the timeout, a manual paste of the callback URL signs in; a bad pasted state is rejected", async () => {
  const pasted = startLogin({ timeoutMs: 50, paste: authUrl => callbackWith(authUrl, { code: CODE, state: stateOf(authUrl) }) });
  const pastedAuth = await authUrlOf(pasted);
  const credential = await pasted.done;
  assert.deepEqual(credential, { type: "oauth", access: KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER });
  assert.equal(pasted.prompts.length, 1);
  assert.equal(pasted.prompts[0].type, "manual_code");
  assert.equal(pasted.prompts[0].message, "Paste the Parallel callback URL from your browser");
  await assertClosed(redirectOf(pastedAuth));

  const bad = startLogin({ timeoutMs: 50, paste: authUrl => callbackWith(authUrl, { code: CODE, state: "wrong-state-value-000000" }) });
  const badAuth = await authUrlOf(bad);
  await assert.rejects(bad.done, /state mismatch/);
  assert.equal(bad.token.requests.length, 0);
  await assertClosed(redirectOf(badAuth));
});

test("a pasted URL that is not the callback path is rejected", async () => {
  const h = startLogin({ timeoutMs: 50, paste: authUrl => callbackWith(authUrl, { code: CODE, state: stateOf(authUrl) }, "/elsewhere") });
  const authUrl = await authUrlOf(h);
  await assert.rejects(h.done, /not the Parallel callback/);
  await assertClosed(redirectOf(authUrl));
});

test("cancelling the login closes the listener and stores nothing", async () => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  assert.equal(await probe("127.0.0.1", portOf(redirectOf(authUrl))), "connected");
  h.controller.abort();
  await assert.rejects(h.done);
  assert.equal(h.token.requests.length, 0);
  await assertClosed(redirectOf(authUrl));
});

test("the listener binds 127.0.0.1 only: loopback IPv6 and a non-loopback address are refused", async t => {
  const h = startLogin();
  const authUrl = await authUrlOf(h);
  const port = portOf(redirectOf(authUrl));
  assert.equal(await probe("127.0.0.1", port), "connected");
  assert.equal(await probe("::1", port), "ECONNREFUSED", "IPv6 loopback is not served");
  const lan = Object.values(networkInterfaces()).flat().find(i => i?.family === "IPv4" && !i.internal);
  if (!lan) t.skip("no non-loopback IPv4 interface on this machine");
  else assert.equal(await probe(lan.address, port), "ECONNREFUSED", "non-loopback address is not served");
  await browse(goodCallback(authUrl));
  await h.done;
});

test("refreshing the credential makes no network call and returns it unchanged", async () => {
  const provider = parallelProvider({ fetch: fakeToken().fetch });
  const credential = { type: "oauth" as const, access: KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER };
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no network"); }) as typeof fetch;
  try {
    assert.equal(await provider.auth.oauth!.refresh(credential, AbortSignal.timeout(1000)), credential);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});

test("secrets never appear in notifications, console output, or errors", async () => {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map(m => console[m]);
  methods.forEach(m => { console[m] = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); }; });
  try {
    const ok = startLogin();
    const okAuth = await authUrlOf(ok);
    await browse(goodCallback(okAuth));
    await ok.done;
    const verifier = new URLSearchParams(ok.token.requests[0]!.init.body as string).get("code_verifier")!;
    const failing = startLogin({ token: fakeToken({ status: 400, body: { error: "invalid_grant", access_token: KEY, code: CODE } }) });
    const failAuth = await authUrlOf(failing);
    await browse(goodCallback(failAuth));
    const error = await failing.done.then(() => undefined, (e: Error) => e);
    const mismatch = startLogin();
    const mismatchAuth = await authUrlOf(mismatch);
    await browse(callbackWith(mismatchAuth, { code: CODE, state: "mismatch-state-value-000000" }));
    const mismatchError = await mismatch.done.then(() => undefined, (e: Error) => e);
    const everything = [
      JSON.stringify(ok.events), JSON.stringify(failing.events), JSON.stringify(mismatch.events),
      logs.join("\n"), String(error?.message), String(error?.stack), String(mismatchError?.message), String(mismatchError?.stack),
    ].join("\n");
    for (const secret of [KEY, CODE, verifier]) assert.equal(everything.includes(secret), false, "a secret leaked");
  } finally {
    methods.forEach((m, i) => { console[m] = originals[i] as any; });
  }
});

test("the browser-stored key is used by tool calls, at call time", async t => {
  const h = await setup(t, () => json(searchPayload));
  delete process.env._PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  h.credentials.parallel = { type: "oauth", access: "first-browser-key", refresh: "", expires: Number.MAX_SAFE_INTEGER };
  await h.start();
  await h.call("web_search", { query: "alpha fact" });
  assert.equal(keyOf(h.calls.at(-1)!), "first-browser-key");
  h.credentials.parallel = { type: "api_key", key: "second-pasted-key" };
  await h.call("web_search", { query: "alpha fact" });
  assert.equal(keyOf(h.calls.at(-1)!), "second-pasted-key", "a pasted key still resolves, and the change applies at the next call");
  h.credentials.parallel = undefined;
  await assert.rejects(h.call("web_search", { query: "alpha fact" }), /\/login/);
  assert.equal(h.calls.length, 2, "after a logout no request is made with the old key");
});

test("the browser login is a sibling of the API-key login, both under the same provider id", () => {
  const provider = parallelProvider();
  assert.equal(provider.id, "parallel");
  assert.ok(provider.auth.oauth && provider.auth.apiKey);
  assert.equal(PARALLEL_KEY_URL, "https://platform.parallel.ai/settings?tab=api-keys");
  assert.deepEqual(provider.getModels(), []);
});
