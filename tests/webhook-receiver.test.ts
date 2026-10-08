import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebhookInbox } from "../src/webhook-inbox.ts";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_WEBHOOK_HOST,
  DEFAULT_WEBHOOK_PATH,
  DEFAULT_WEBHOOK_PORT,
  DEFAULT_WEBHOOK_SCHEME,
  WEBTASKS_DIR_ENV,
  WEBHOOK_PORT_ENV,
  WEBHOOK_PATH_ENV,
  WEBHOOK_SCHEME_ENV,
  WEBHOOK_SECRET_ENV,
  defaultResultsDir,
  startWebhookReceiver,
} from "../src/webhook-receiver.ts";

const SECRET = "whsec_dGVzdHNlY3JldA==";
const ROTATED = "whsec_cm90YXRlZHNlY3JldA==";
const LEGACY_SECRET = "whsec_legacy_test_secret";
const EVENT = '{"type":"task_run.status","data":{"run_id":"trun_1","status":"completed"}}';
const RECEIVER_FILE = fileURLToPath(new URL("../src/webhook-receiver.ts", import.meta.url));

function signStandard(secret: string, id: string, ts: string, body: string): string {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return createHmac("sha256", Buffer.from(raw, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
}

function signLegacy(secret: string, id: string, ts: string, body: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function tmpDir(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "webhook-receiver-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function start(t: import("node:test").TestContext, opts: {
  secret?: string | string[];
  scheme?: "standard" | "legacy";
  maxBodyBytes?: number;
  path?: string;
  inbox?: WebhookInbox;
} = {}) {
  const dir = await tmpDir(t);
  const inbox = opts.inbox ?? new WebhookInbox(dir);
  const receiver = await startWebhookReceiver({
    inbox,
    secret: opts.secret ?? SECRET,
    scheme: opts.scheme,
    port: 0,
    host: DEFAULT_WEBHOOK_HOST,
    path: opts.path,
    maxBodyBytes: opts.maxBodyBytes,
  });
  t.after(() => receiver.close());
  return { inbox, receiver, dir };
}

async function post(url: string, body: string, headers: Record<string, string>, method = "POST") {
  const res = await fetch(url, { method, headers, body, redirect: "error" });
  const text = await res.text();
  return { status: res.status, text, allow: res.headers.get("allow") };
}

function signedHeaders(secret: string, id: string, body: string, scheme: "standard" | "legacy" = "standard", ts = String(nowSec())) {
  const sig = scheme === "legacy" ? signLegacy(secret, id, ts, body) : signStandard(secret, id, ts, body);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
  };
}

function assertNoLeak(text: string, body = "") {
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(LEGACY_SECRET), false);
  assert.equal(text.includes(ROTATED), false);
  if (body.length > 0) assert.equal(text.includes(body), false);
}

test("the standalone receiver's fallback results live under the agent's webtasks directory", () => {
  assert.equal(defaultResultsDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/webtasks/results");
  assert.equal(defaultResultsDir({ HOME: "/tmp/home" }), join(homedir(), ".pi", "agent", "webtasks", "results"));
});

test("public configuration matches the agreed local receiver contract", () => {
  assert.equal(DEFAULT_WEBHOOK_HOST, "127.0.0.1");
  assert.equal(DEFAULT_WEBHOOK_PORT, 8787);
  assert.equal(DEFAULT_WEBHOOK_PATH, "/webtasks/webhook");
  assert.equal(DEFAULT_WEBHOOK_SCHEME, "standard");
  assert.equal(DEFAULT_MAX_BODY_BYTES, 1_048_576);
  assert.equal(WEBHOOK_SECRET_ENV, "PARALLEL_WEBHOOK_KEY");
  assert.equal(WEBHOOK_SCHEME_ENV, "WEBTASKS_WEBHOOK_SCHEME");
  assert.equal(WEBHOOK_PORT_ENV, "WEBTASKS_WEBHOOK_PORT");
  assert.equal(WEBHOOK_PATH_ENV, "WEBTASKS_WEBHOOK_PATH");
  assert.equal(WEBTASKS_DIR_ENV, "WEBTASKS_DIR");
});

test("rejects missing, empty, and invalid config before listening", async t => {
  const dir = await tmpDir(t);
  const inbox = new WebhookInbox(dir);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: "" }), /secret/);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: ["", "   "] }), /secret/);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: SECRET, scheme: "other" as "standard" }), /scheme/);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: SECRET, port: 70000 }), /port/);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: SECRET, host: "" }), /host/);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: SECRET, path: "webtasks/webhook" }), /path/);
  await assert.rejects(() => startWebhookReceiver({ inbox, secret: SECRET, maxBodyBytes: 0 }), /maxBodyBytes/);
});

test("accepts a valid standard-scheme delivery and persists webhook_id + event only", async t => {
  const { inbox, receiver } = await start(t);
  assert.match(receiver.url, /^http:\/\/127\.0\.0\.1:\d+\/webtasks\/webhook$/);
  const id = "whevent_standard";
  const res = await post(receiver.url, EVENT, signedHeaders(SECRET, id, EVENT));
  assert.equal(res.status, 200);
  assert.equal(res.text, "ok");
  assertNoLeak(res.text, EVENT);
  const rows = await inbox.listAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.webhook_id, id);
  assert.deepEqual(rows[0]!.event, JSON.parse(EVENT));
  assert.equal(rows[0]!.resource_id, undefined);
  assert.equal(rows[0]!.kind, undefined);
});

test("accepts a valid explicit legacy-scheme delivery", async t => {
  const { inbox, receiver } = await start(t, { secret: LEGACY_SECRET, scheme: "legacy" });
  const id = "whevent_legacy";
  const res = await post(receiver.url, EVENT, signedHeaders(LEGACY_SECRET, id, EVENT, "legacy"));
  assert.equal(res.status, 200);
  assert.equal((await inbox.listAll()).length, 1);
});

test("standard and legacy signatures are not interchangeable on the HTTP path", async t => {
  const { inbox, receiver } = await start(t);
  const id = "whevent_cross";
  const legacyHeaders = signedHeaders(SECRET, id, EVENT, "legacy");
  const res = await post(receiver.url, EVENT, legacyHeaders);
  assert.equal(res.status, 401);
  assert.equal((await inbox.listAll()).length, 0);
});

test("accepts overlapping secrets during rotation", async t => {
  const { inbox, receiver } = await start(t, { secret: [SECRET, ROTATED] });
  const id = "whevent_rot";
  const res = await post(receiver.url, EVENT, signedHeaders(ROTATED, id, EVENT));
  assert.equal(res.status, 200);
  assert.equal((await inbox.listAll())[0]!.webhook_id, id);
});

test("duplicate webhook-id returns success without a second event, including concurrent posts", async t => {
  const { inbox, receiver } = await start(t);
  const id = "whevent_dup";
  const headers = signedHeaders(SECRET, id, EVENT);
  const [a, b, c] = await Promise.all([
    post(receiver.url, EVENT, headers),
    post(receiver.url, EVENT, headers),
    post(receiver.url, EVENT, headers),
  ]);
  assert.deepEqual([a.status, b.status, c.status].sort(), [200, 200, 200]);
  const rows = await inbox.listAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.webhook_id, id);
});

test("missing, malformed, and stale signatures never persist", async t => {
  const { inbox, receiver } = await start(t);
  const id = "whevent_bad";
  const ts = String(nowSec());
  const good = signedHeaders(SECRET, id, EVENT, "standard", ts);
  const cases: Array<Record<string, string>> = [
    { "content-type": "application/json" },
    { ...good, "webhook-signature": "v1," },
    { ...good, "webhook-signature": "v2,AAAA" },
    { ...good, "webhook-signature": `${good["webhook-signature"]}!` },
    { ...good, "webhook-signature": `v1,${signStandard(SECRET, id, ts, EVENT).replace(/=+$/, "")}` },
    { ...good, "webhook-signature": `v1,${signStandard(SECRET, id, ts, EVENT).replace(/=$/, "==")}` },
    { ...good, "webhook-signature": `v1,${signStandard(SECRET, id, ts, "{}")}` },
    { ...good, "webhook-timestamp": String(nowSec() - 400) },
    { ...good, "webhook-timestamp": "1e9" },
    { ...good, "webhook-timestamp": `${nowSec()}.0` },
  ];
  for (const headers of cases) {
    const res = await post(receiver.url, EVENT, headers);
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(headers)}`);
    assertNoLeak(res.text, EVENT);
  }
  assert.equal((await inbox.listAll()).length, 0);
});

test("wrong method and unknown path do not persist", async t => {
  const { inbox, receiver } = await start(t);
  const headers = signedHeaders(SECRET, "whevent_path", EVENT);
  const get = await fetch(receiver.url, { method: "GET", redirect: "error" });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const put = await post(receiver.url, EVENT, headers, "PUT");
  assert.equal(put.status, 405);
  assert.equal(put.allow, "POST");
  const other = await post(new URL("/nope", receiver.url).href, EVENT, headers);
  assert.equal(other.status, 404);
  assert.equal((await inbox.listAll()).length, 0);
});

test("malformed payloads with valid signatures are rejected without put", async t => {
  const { inbox, receiver } = await start(t);
  const bodies = ["", "null", "[]", "\"x\"", "{\"type\":\"task_run.status\"}", "{\"type\":\"\",\"data\":{}}", "{\"type\":\"task_run.status\",\"data\":[]}"];
  for (const body of bodies) {
    const id = `whevent_payload_${bodies.indexOf(body)}`;
    const res = await post(receiver.url, body, signedHeaders(SECRET, id, body));
    assert.equal(res.status, 400, body);
    assertNoLeak(res.text, body);
  }
  assert.equal((await inbox.listAll()).length, 0);
});

test("invalid UTF-8 cannot reuse a signature for a different decoded body", async t => {
  const { inbox, receiver } = await start(t);
  const body = Buffer.concat([
    Buffer.from('{"type":"task_run.status","data":{"note":"'),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ]);
  const res = await fetch(receiver.url, {
    method: "POST",
    headers: signedHeaders(SECRET, "invalid-utf8", body.toString("utf8")),
    body,
  });
  assert.equal(res.status, 400);
  await res.text();
  assert.equal((await inbox.listAll()).length, 0);
});

test("oversized bodies are rejected within the configured bound", async t => {
  const { inbox, receiver } = await start(t, { maxBodyBytes: 64 });
  const body = `{"type":"task_run.status","data":{"pad":"${"x".repeat(200)}"}}`;
  assert.ok(body.length > 64);
  const res = await post(receiver.url, body, signedHeaders(SECRET, "whevent_big", body));
  assert.equal(res.status, 413);
  assertNoLeak(res.text, body);
  assert.equal((await inbox.listAll()).length, 0);
});

test("durable put failure does not ACK", async t => {
  const dir = await tmpDir(t);
  class FailingInbox extends WebhookInbox {
    override async put(): Promise<{ accepted: boolean; duplicate: boolean }> {
      throw new Error("disk failed");
    }
  }
  const inbox = new FailingInbox(dir);
  const { receiver } = await start(t, { inbox });
  const res = await post(receiver.url, EVENT, signedHeaders(SECRET, "whevent_fail", EVENT));
  assert.equal(res.status, 500);
  assert.equal(res.text.includes("disk"), false);
  assertNoLeak(res.text, EVENT);
});

test("standalone CLI requires config, validates path, and serves a non-default path until SIGTERM", async t => {
  const missing = await new Promise<{ code: number | null; stderr: string }>(resolvePromise => {
    const child = spawn(process.execPath, [RECEIVER_FILE], {
      env: { ...process.env, [WEBHOOK_SECRET_ENV]: "", [WEBTASKS_DIR_ENV]: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolvePromise({ code, stderr }));
  });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /PARALLEL_WEBHOOK_KEY|WEBTASKS_DIR/);
  assert.equal(missing.stderr.includes(SECRET), false);

  const invalidDir = await tmpDir(t);
  const invalidPath = await new Promise<{ code: number | null; stderr: string }>(resolvePromise => {
    const child = spawn(process.execPath, [RECEIVER_FILE], {
      env: {
        ...process.env,
        [WEBHOOK_SECRET_ENV]: SECRET,
        [WEBTASKS_DIR_ENV]: invalidDir,
        [WEBHOOK_PORT_ENV]: "0",
        [WEBHOOK_PATH_ENV]: "webtasks-test-path",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolvePromise({ code, stderr }));
  });
  assert.notEqual(invalidPath.code, 0);
  assert.match(invalidPath.stderr, /invalid webhook path/);
  assert.equal(invalidPath.stderr.includes(SECRET), false);

  const dir = await tmpDir(t);
  const child = spawn(process.execPath, [RECEIVER_FILE], {
    env: {
      ...process.env,
      [WEBHOOK_SECRET_ENV]: SECRET,
      [WEBTASKS_DIR_ENV]: dir,
      [WEBHOOK_PORT_ENV]: "0",
      [WEBHOOK_PATH_ENV]: "/webtasks/webhook",
      [WEBHOOK_SCHEME_ENV]: "standard",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill("SIGKILL");
  });
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("CLI did not print a listen URL")), 5000);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const line = stdout.split("\n").find(item => item.startsWith("http://"));
      if (line) {
        clearTimeout(timer);
        resolveUrl(line);
      }
    });
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("exit", (code, signal) => {
      if (!stdout.includes("http://")) {
        clearTimeout(timer);
        reject(new Error(`CLI exited ${code}/${signal}: ${stderr}`));
      }
    });
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/webtasks\/webhook$/);
  const res = await post(url, EVENT, signedHeaders(SECRET, "whevent_cli", EVENT));
  assert.equal(res.status, 200);
  const inbox = new WebhookInbox(dir);
  const rows = await inbox.listAll();
  assert.equal(rows.length, 1);
  child.kill("SIGTERM");
  await new Promise<void>(resolveClose => child.once("close", () => resolveClose()));
});
