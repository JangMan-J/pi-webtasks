import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SEC = 300;
// A degenerate (empty or non-canonical-Base64) secret decodes to a zero-byte
// HMAC key, which is publicly predictable (there is exactly one such key)
// and must never be accepted as a valid signing key.
const MIN_KEY_BYTES = 1;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_UNIX_TIMESTAMP = /^[0-9]+$/;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function padB64(s: string): string {
  const m = s.length % 4;
  return m ? s + "=".repeat(4 - m) : s;
}

function decodeBase64(s: string, options: { allowUnpadded: boolean }): Buffer | undefined {
  if (!s || !CANONICAL_BASE64.test(s)) return undefined;
  if (s.length % 4 === 1) return undefined;
  const padded = padB64(s);
  if (!options.allowUnpadded && s !== padded) return undefined;
  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64") !== padded) return undefined;
  return decoded;
}

function parseTimestamp(timestamp: string): number | undefined {
  if (!DECIMAL_UNIX_TIMESTAMP.test(timestamp)) return undefined;
  const ts = Number(timestamp);
  return Number.isSafeInteger(ts) ? ts : undefined;
}

/**
 * Standard-scheme signing key: strips the documented `whsec_` prefix, then
 * requires canonical RFC 4648 Base64 (the setup guide's padded form, or the
 * documented unpadded variant \u2014 nothing else). Node's Buffer base64 decoder
 * is lenient and silently drops invalid characters, which would otherwise let
 * garbage input such as `"!!!!"` decode to an empty (zero-byte) key. A
 * round-trip re-encode check rejects any input the regex alone would miss.
 * Returns undefined (never a zero/degenerate key) for empty, malformed, or
 * too-short secrets so callers can skip them rather than sign with one.
 */
function decodeSecret(secret: string): Buffer | undefined {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = decodeBase64(raw, { allowUnpadded: true });
  if (!key || key.length < MIN_KEY_BYTES) return undefined;
  return key;
}

/** Legacy-scheme signing key: the literal secret string as raw UTF-8 bytes. */
function decodeLegacySecret(secret: string): Buffer | undefined {
  if (!secret) return undefined;
  const key = Buffer.from(secret, "utf8");
  return key.length < MIN_KEY_BYTES ? undefined : key;
}

function parseSignatures(header: string): Buffer[] {
  const out: Buffer[] = [];
  for (const part of header.trim().split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const ver = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    const decoded = ver === "v1" ? decodeBase64(sig, { allowUnpadded: false }) : undefined;
    if (decoded) out.push(decoded);
  }
  return out;
}

function sameMac(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Legacy Parallel signing scheme: HMAC-SHA256 keyed by the entire secret
 * string, including the `whsec_` prefix, used as raw UTF-8 bytes (not
 * Base64-decoded). Documented as still supported for existing accounts.
 * Callers must opt in explicitly; this is never derived automatically from a
 * standard-scheme Base64-decode failure. See docs/webhook-integration-review.md \u00a73.
 */
export function verifyWebhookLegacy(input: {
  secret: string | string[];
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
  nowSec?: number;
  maxSkewSec?: number;
}): VerifyResult {
  if (!input.id || !input.timestamp || input.signatureHeader == null || input.signatureHeader === "") {
    return { ok: false, reason: "malformed headers" };
  }
  const ts = parseTimestamp(input.timestamp);
  if (ts === undefined) return { ok: false, reason: "invalid timestamp" };
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSec ?? MAX_SKEW_SEC;
  if (Math.abs(now - ts) > skew) return { ok: false, reason: "timestamp out of range" };

  const sigs = parseSignatures(input.signatureHeader);
  if (sigs.length === 0) return { ok: false, reason: "malformed signatures" };

  const secrets = Array.isArray(input.secret) ? input.secret : [input.secret];
  const payload = `${input.id}.${input.timestamp}.${input.body}`;
  for (const secret of secrets) {
    const key = decodeLegacySecret(secret);
    if (!key) continue; // empty/degenerate secret: never sign or match with it
    const expected = createHmac("sha256", key).update(payload).digest();
    for (const given of sigs) {
      if (sameMac(given, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "invalid signature" };
}

/** Standard Webhooks HMAC-SHA256 over `webhook-id.webhook-timestamp.raw-body`. */
export function verifyWebhook(input: {
  secret: string | string[];
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
  nowSec?: number;
  maxSkewSec?: number;
}): VerifyResult {
  if (!input.id || !input.timestamp || input.signatureHeader == null || input.signatureHeader === "") {
    return { ok: false, reason: "malformed headers" };
  }
  const ts = parseTimestamp(input.timestamp);
  if (ts === undefined) return { ok: false, reason: "invalid timestamp" };
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSec ?? MAX_SKEW_SEC;
  if (Math.abs(now - ts) > skew) return { ok: false, reason: "timestamp out of range" };

  const sigs = parseSignatures(input.signatureHeader);
  if (sigs.length === 0) return { ok: false, reason: "malformed signatures" };

  const secrets = Array.isArray(input.secret) ? input.secret : [input.secret];
  const payload = `${input.id}.${input.timestamp}.${input.body}`;
  for (const secret of secrets) {
    const key = decodeSecret(secret);
    if (!key) continue; // empty/malformed/degenerate secret: never sign or match with it
    const expected = createHmac("sha256", key).update(payload).digest();
    for (const given of sigs) {
      if (sameMac(given, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "invalid signature" };
}
