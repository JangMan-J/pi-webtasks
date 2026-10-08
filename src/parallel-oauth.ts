// Parallel browser sign-in: OAuth 2.0 authorization code with PKCE (S256) against /getKeys/. The contract is
// result:pkce-contract#1. The token response's access_token is the user's long-lived Parallel API key.
// Only type imports from pi-ai, so this module loads without the Pi runtime.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

export const PARALLEL_AUTHORIZE_URL = "https://platform.parallel.ai/getKeys/authorize";
export const PARALLEL_TOKEN_URL = "https://platform.parallel.ai/getKeys/token";
export const CALLBACK_TIMEOUT_MS = 120_000;
export const MANUAL_PASTE_MESSAGE = "Paste the Parallel callback URL from your browser";

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const SCOPE = "key:read";
const TOKEN_TIMEOUT_MS = 30_000;
const RESPONSE_FLUSH_MS = 1_000;

const SUCCESS_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Parallel</title><p>Authorization received. You can close this tab and return to Pi to finish sign-in.</p>";
const FAILURE_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Parallel</title><p>Parallel sign-in did not complete. You can close this tab and return to Pi.</p>";

export type BrowserLoginOptions = {
  /** Token-endpoint transport. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How long to wait for the browser before offering the manual paste. Defaults to 120 s. */
  callbackTimeoutMs?: number;
};

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** PKCE verifier (32 random bytes, base64url) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The authorize URL with exactly the parameters the contract lists. client_id is the redirect host. */
export function authorizeUrl(redirectUri: string, state: string, challenge: string): string {
  const url = new URL(PARALLEL_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: new URL(redirectUri).hostname,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  return url.toString();
}

/** The authorization code from a callback URL. Checks state first, then reports an error, then reads the code. */
function codeFromCallback(url: URL, state: string): string {
  if (url.searchParams.get("state") !== state) {
    throw new Error("The sign-in response does not match this login (state mismatch). Start the login again.");
  }
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") || error;
    throw new Error(`Parallel sign-in failed: ${description.slice(0, 200)}`);
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The sign-in response had no authorization code.");
  return code;
}

/** A pasted callback URL: must be the callback path, with the same state checks as the listener. */
function codeFromPastedUrl(text: string, state: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error("That is not a callback URL. Paste the full address from the browser's address bar.");
  }
  if (url.pathname !== CALLBACK_PATH) throw new Error("That URL is not the Parallel callback.");
  return codeFromCallback(url, state);
}

/**
 * One-shot loopback listener on 127.0.0.1 with an ephemeral port. It accepts only GET /callback. A valid
 * callback settles `code`; a state mismatch or error settles it with a rejection. It closes in `close()`.
 */
class LoopbackCallback {
  readonly code: Promise<string>;
  private readonly server: Server;
  private readonly responses: Promise<void>[] = [];
  private readonly state: string;
  private resolveCode!: (code: string) => void;
  private rejectCode!: (error: Error) => void;
  private settled = false;

  constructor(state: string) {
    this.state = state;
    this.code = new Promise<string>((resolve, reject) => { this.resolveCode = resolve; this.rejectCode = reject; });
    this.code.catch(() => undefined); // a callback that arrives after the flow ended must not surface as unhandled
    this.server = createServer((req, res) => this.handle(req, res));
  }

  /** Binds before returning, so the caller can notify the redirect URI. */
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, LOOPBACK_HOST, () => { this.server.off("error", reject); resolve(); });
    });
    const { port } = this.server.address() as AddressInfo;
    return `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      res.end("Bad request");
      return;
    }
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || this.settled) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      res.end("Not found");
      return;
    }
    let ok = true;
    try {
      this.resolveCode(codeFromCallback(url, this.state));
    } catch (error) {
      ok = false;
      this.rejectCode(error instanceof Error ? error : new Error(String(error)));
    }
    this.settled = true;
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Connection": "close" });
    this.responses.push(new Promise<void>(done => { res.once("finish", () => done()); res.once("close", () => done()); }));
    res.end(ok ? SUCCESS_PAGE : FAILURE_PAGE);
  }

  /** Lets the browser receive its response, then closes every connection and the listener. */
  async close(): Promise<void> {
    if (!this.server.listening) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushed = new Promise<void>(resolve => { timer = setTimeout(resolve, RESPONSE_FLUSH_MS); });
    await Promise.race([Promise.all(this.responses), flushed]);
    clearTimeout(timer);
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }
}

/** Rejects when the login is cancelled. Never resolves otherwise. */
function cancellation(signal: AbortSignal): Promise<never> {
  const reason = () => signal.reason ?? new Error("Login cancelled");
  const pending = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(reason());
    else signal.addEventListener("abort", () => reject(reason()), { once: true });
  });
  pending.catch(() => undefined);
  return pending;
}

/**
 * Waits for the browser callback. After the timeout, offers a manual paste of the callback URL, as Pi's
 * login does for SSH sessions without port forwarding. Whichever arrives first wins.
 */
async function receiveCode(
  interaction: ProviderAuthInteraction,
  callback: LoopbackCallback,
  state: string,
  redirectUri: string,
  timeoutMs: number,
  cancelled: Promise<never>,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ kind: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs); });
  const browser = callback.code.then(code => ({ kind: "code" as const, code }));
  const first = await Promise.race([browser, timedOut, cancelled]).finally(() => clearTimeout(timer));
  if (first.kind === "code") return first.code;

  const paste = new AbortController();
  const pasted = interaction.prompt({ type: "manual_code", message: MANUAL_PASTE_MESSAGE, placeholder: redirectUri, signal: paste.signal })
    .then(text => ({ kind: "paste" as const, text }));
  try {
    const second = await Promise.race([browser, pasted, cancelled]);
    return second.kind === "code" ? second.code : codeFromPastedUrl(second.text, state);
  } finally {
    paste.abort();
  }
}

/** Exchanges the code at /getKeys/token. Errors never include the response body, the code, or the verifier. */
async function exchangeCode(input: {
  fetch: typeof fetch;
  code: string;
  verifier: string;
  redirectUri: string;
  signal: AbortSignal;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: new URL(input.redirectUri).hostname,
  });
  const response = await input.fetch(PARALLEL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new Error(`Parallel did not return a key (HTTP ${response.status}). Start the login again.`);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Parallel's token response was not JSON.");
  }
  const token = (data as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || !token.trim()) throw new Error("Parallel's token response had no access_token.");
  return token.trim();
}

/**
 * The browser sign-in. Returns the OAuth credential Pi stores. The key is long-lived, so the expiry is a
 * sentinel that Pi's refresh checks (`now + 5 min >= expires`, pi-ai auth/resolve.js) never reach.
 */
export async function browserLogin(interaction: ProviderAuthInteraction, options: BrowserLoginOptions = {}): Promise<OAuthCredential> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS;
  interaction.signal.throwIfAborted();
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const callback = new LoopbackCallback(state);
  try {
    const redirectUri = await callback.start(); // bound before the URL is shown
    interaction.notify({
      type: "auth_url",
      url: authorizeUrl(redirectUri, state, challenge),
      instructions: "Approve Parallel in your browser, then select or create a key. Return to Pi when the page says you can close it.",
    });
    const cancelled = cancellation(interaction.signal);
    const code = await receiveCode(interaction, callback, state, redirectUri, timeoutMs, cancelled);
    const apiKey = await exchangeCode({ fetch: fetchImpl, code, verifier, redirectUri, signal: interaction.signal });
    return { type: "oauth", access: apiKey, refresh: "", expires: Number.MAX_SAFE_INTEGER };
  } finally {
    await callback.close();
  }
}
