import "./env.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isUtf8 } from "node:buffer";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { WebhookInbox } from "./webhook-inbox.ts";
import { WebhookWorker } from "./webhook-worker.ts";
import { verifyWebhook, verifyWebhookLegacy } from "./webhook.ts";

/** Loopback only by default; tests pass `port: 0`. */
export const DEFAULT_WEBHOOK_HOST = "127.0.0.1";
export const DEFAULT_WEBHOOK_PORT = 8787;
export const DEFAULT_WEBHOOK_PATH = "/parallel/webhook";
export const DEFAULT_WEBHOOK_SCHEME = "standard";
/** Bounded in-memory cap for a single delivery body. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/**
 * Conventional location under the Pi agent dir (`<agent-dir>/parallelized/webhooks`).
 * Standalone CLI requires `PIPARA_WEBHOOK_DIR` so this helper does not import Pi.
 * Share the same directory with the consumer.
 */
export const CONVENTIONAL_WEBHOOK_INBOX_DIR = "parallelized/webhooks";

export const WEBHOOK_SECRET_ENV = "PIPARA_WEBHOOK_SECRET";
export const WEBHOOK_SCHEME_ENV = "PIPARA_WEBHOOK_SCHEME";
export const WEBHOOK_PORT_ENV = "PIPARA_WEBHOOK_PORT";
export const WEBHOOK_PATH_ENV = "PIPARA_WEBHOOK_PATH";
export const WEBHOOK_DIR_ENV = "PIPARA_WEBHOOK_DIR";

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_MS = 5_000;
const CLOSE_FORCE_MS = 1_000;

export type WebhookReceiverScheme = "standard" | "legacy";

export async function startWebhookReceiver(options: {
  inbox: WebhookInbox;
  secret: string | string[];
  scheme?: WebhookReceiverScheme;
  port?: number;
  host?: string;
  path?: string;
  maxBodyBytes?: number;
  /** Called after the event is durable and the HTTP ack has been queued. Must not fetch. */
  onAccepted?: () => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const secrets = usableSecrets(options.secret);
  const scheme = options.scheme ?? DEFAULT_WEBHOOK_SCHEME;
  if (scheme !== "standard" && scheme !== "legacy") {
    throw new Error("invalid webhook scheme");
  }
  const host = options.host ?? DEFAULT_WEBHOOK_HOST;
  if (typeof host !== "string" || host.length === 0 || host !== host.trim()) {
    throw new Error("invalid webhook host");
  }
  const port = options.port ?? DEFAULT_WEBHOOK_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("invalid webhook port");
  }
  const path = options.path ?? DEFAULT_WEBHOOK_PATH;
  if (typeof path !== "string" || !path.startsWith("/") || /[?#\s]/.test(path)) {
    throw new Error("invalid webhook path");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("invalid webhook maxBodyBytes");
  }
  const verify = scheme === "legacy" ? verifyWebhookLegacy : verifyWebhook;
  const inbox = options.inbox;

  const server = createServer({
    requestTimeout: REQUEST_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_MS,
    joinDuplicateHeaders: false,
  }, (req, res) => {
    void handleRequest({ req, res, inbox, secrets, verify, path, maxBodyBytes, onAccepted: options.onAccepted }).catch(() => {
      reply(res, 500, "unavailable");
    });
  });
  server.timeout = SOCKET_TIMEOUT_MS;
  server.maxHeadersCount = 50;

  try {
    await listen(server, port, host);
  } catch (err) {
    server.close();
    throw err;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("webhook receiver failed to bind");
  }
  const url = httpUrl(host, address, path);

  let closed = false;
  return {
    url,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

function usableSecrets(secret: string | string[]): string[] {
  const list = Array.isArray(secret) ? secret : [secret];
  if (list.length === 0 || list.some(item => typeof item !== "string")) {
    throw new Error("webhook secret is required");
  }
  const usable = list.filter(item => item.trim().length > 0);
  if (usable.length === 0) throw new Error("webhook secret is required");
  return usable;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function reply(res: ServerResponse, status: number, message: string, extra?: Record<string, string>): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    if (extra) {
      for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
    }
  }
  res.end(message);
}

function isBasicEvent(value: unknown): value is { type: string; data: object } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { type?: unknown; data?: unknown };
  return typeof record.type === "string" && record.type.length > 0
    && record.data !== null && typeof record.data === "object" && !Array.isArray(record.data);
}

async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<{ ok: true; body: string } | { ok: false; status: 400 | 413 }> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    req.resume();
    return { ok: false, status: 413 };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBodyBytes) {
        oversized = true;
        chunks.length = 0;
        continue;
      }
      if (!oversized) chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  if (oversized) return { ok: false, status: 413 };
  const bytes = Buffer.concat(chunks);
  // String-based verification must round-trip the exact signed bytes.
  if (!isUtf8(bytes)) return { ok: false, status: 400 };
  return { ok: true, body: bytes.toString("utf8") };
}

async function handleRequest(input: {
  req: IncomingMessage;
  res: ServerResponse;
  inbox: WebhookInbox;
  secrets: string[];
  verify: typeof verifyWebhook;
  path: string;
  maxBodyBytes: number;
  onAccepted?: () => void;
}): Promise<void> {
  const { req, res, inbox, secrets, verify, path, maxBodyBytes, onAccepted } = input;
  if (pathnameOf(req) !== path) {
    reply(res, 404, "not found");
    req.resume();
    return;
  }
  if (req.method !== "POST") {
    reply(res, 405, "method not allowed", { Allow: "POST" });
    req.resume();
    return;
  }

  const raw = await readBody(req, maxBodyBytes);
  if (!raw.ok) {
    reply(res, raw.status, raw.status === 413 ? "payload too large" : "bad request");
    return;
  }

  const verified = verify({
    secret: secrets,
    id: header(req, "webhook-id"),
    timestamp: header(req, "webhook-timestamp"),
    body: raw.body,
    signatureHeader: header(req, "webhook-signature"),
  });
  if (!verified.ok) {
    reply(res, 401, "unauthorized");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body);
  } catch {
    reply(res, 400, "bad request");
    return;
  }
  if (!isBasicEvent(parsed)) {
    reply(res, 400, "bad request");
    return;
  }

  try {
    await inbox.put({ webhook_id: header(req, "webhook-id"), event: parsed });
  } catch {
    reply(res, 500, "unavailable");
    return;
  }
  reply(res, 200, "ok");
  try { onAccepted?.(); } catch { /* a wake failure must not change the ack */ }
}

/**
 * Fallback artifact root for the standalone receiver. Matches the legacy
 * `<agent-dir>/parallelized/results` layout when that directory is known.
 * A registration's artifact_dir overrides this.
 */
export function legacyResultDir(webhookDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const agent = env.PI_CODING_AGENT_DIR?.trim();
  if (agent) return join(agent, "parallelized", "results");
  const base = resolve(webhookDir);
  if (basename(base) === "webhooks" && basename(dirname(base)) === "parallelized") {
    return join(dirname(base), "results");
  }
  return join(base, "results");
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function httpUrl(host: string, address: AddressInfo, path: string): string {
  const hostname = host.includes(":") ? `[${host}]` : host;
  return `http://${hostname}:${address.port}${path}`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), CLOSE_FORCE_MS);
    server.close(err => {
      clearTimeout(force);
      if (err) reject(err);
      else resolveClose();
    });
    server.closeIdleConnections();
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

function envConfig(env: NodeJS.ProcessEnv): {
  secret: string;
  scheme: WebhookReceiverScheme;
  port: number;
  path: string;
  dir: string;
} {
  const secret = env[WEBHOOK_SECRET_ENV];
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error(`${WEBHOOK_SECRET_ENV} is required`);
  }
  const dir = env[WEBHOOK_DIR_ENV];
  if (typeof dir !== "string" || dir.trim().length === 0) {
    throw new Error(`${WEBHOOK_DIR_ENV} is required (share with consumer; conventional path: <agent-dir>/${CONVENTIONAL_WEBHOOK_INBOX_DIR})`);
  }
  const schemeRaw = env[WEBHOOK_SCHEME_ENV] ?? DEFAULT_WEBHOOK_SCHEME;
  if (schemeRaw !== "standard" && schemeRaw !== "legacy") {
    throw new Error(`${WEBHOOK_SCHEME_ENV} must be standard or legacy`);
  }
  const portRaw = env[WEBHOOK_PORT_ENV];
  const port = portRaw === undefined || portRaw === "" ? DEFAULT_WEBHOOK_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${WEBHOOK_PORT_ENV} must be an integer 0-65535`);
  }
  const pathRaw = env[WEBHOOK_PATH_ENV];
  const path = pathRaw === undefined || pathRaw === "" ? DEFAULT_WEBHOOK_PATH : pathRaw;
  return { secret, scheme: schemeRaw, port, path, dir };
}

async function cliMain(): Promise<void> {
  const { secret, scheme, port, path, dir } = envConfig(process.env);
  const inbox = new WebhookInbox(dir);
  await inbox.init();
  const { researchClient } = await import("./ops.ts");
  const worker = new WebhookWorker({
    inbox,
    getClient: researchClient,
    artifactDir: legacyResultDir(dir),
    onLog: msg => process.stderr.write(`${msg}\n`),
  });
  const receiver = await startWebhookReceiver({
    inbox, secret, scheme, port, host: DEFAULT_WEBHOOK_HOST, path,
    onAccepted: () => worker.kick(),
  });
  await worker.start();
  process.stdout.write(`${receiver.url}\n`);
  await new Promise<void>(resolveWait => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        await worker.stop();
        await receiver.close();
        await inbox.close();
      })().finally(resolveWait);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (isDirectRun()) {
  cliMain().catch(err => {
    const message = err instanceof Error ? err.message : "webhook receiver failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
