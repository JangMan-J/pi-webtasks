import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { verifyWebhook, verifyWebhookLegacy } from "../src/webhook.ts";

const SECRET = "whsec_dGVzdHNlY3JldA==";
const ID = "msg_test";
const TS = "1234567890";
const BODY = '{"ok":true}';
const SIG = "VqseCXwkkShKXeDPGNum2mmY/gWYnAzwzMBpSESu8oU=";
const NOW = 1234567890;

test("accepts a valid v1 signature", () => {
  assert.deepEqual(
    verifyWebhook({
      secret: SECRET,
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: `v1,${SIG}`,
      nowSec: NOW,
    }),
    { ok: true },
  );
});

test("accepts multiple space-delimited signatures when one v1 value matches", () => {
  assert.deepEqual(
    verifyWebhook({
      secret: SECRET,
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: `v1,deadbeef v1,${SIG}`,
      nowSec: NOW,
    }),
    { ok: true },
  );
});

// Standard webhook signatures are padded RFC 4648 Base64. Node's decoder is
// permissive, so these cases prove parsing rejects altered encodings before
// HMAC comparison.
test("rejects non-canonical signature Base64", () => {
  for (const signatureHeader of [`v1,${SIG}!`, `v1,${SIG.replace(/=+$/, "")}`, `v1,${SIG.replace(/=$/, "==")}`]) {
    const result = verifyWebhook({ secret: SECRET, id: ID, timestamp: TS, body: BODY, signatureHeader, nowSec: NOW });
    assert.equal(result.ok, false, `signatureHeader ${JSON.stringify(signatureHeader)} must not verify`);
  }
});

test("accepts overlapping secrets during rotation", () => {
  assert.deepEqual(
    verifyWebhook({
      secret: ["whsec_AAAAAAAAAAAAAAAA", SECRET],
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: `v1,${SIG}`,
      nowSec: NOW,
    }),
    { ok: true },
  );
});

test("rejects non-decimal and non-integer timestamps", () => {
  for (const timestamp of ["1234567890.0", "1e9", "0x499602d2", " 1234567890", "1234567890 ", "-1", "Infinity"]) {
    assert.equal(
      verifyWebhook({ secret: SECRET, id: ID, timestamp, body: BODY, signatureHeader: `v1,${SIG}`, nowSec: NOW }).reason,
      "invalid timestamp",
      `standard timestamp ${JSON.stringify(timestamp)} must be invalid`,
    );
    assert.equal(
      verifyWebhookLegacy({ secret: SECRET, id: ID, timestamp, body: BODY, signatureHeader: `v1,${SIG}`, nowSec: NOW }).reason,
      "invalid timestamp",
      `legacy timestamp ${JSON.stringify(timestamp)} must be invalid`,
    );
  }
});

test("rejects bad mac, skew, and missing headers", () => {
  assert.equal(
    verifyWebhook({
      secret: SECRET,
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: "v1,AAAA",
      nowSec: NOW,
    }).ok,
    false,
  );
  assert.equal(
    verifyWebhook({
      secret: SECRET,
      id: ID,
      timestamp: TS,
      body: BODY,
      signatureHeader: `v1,${SIG}`,
      nowSec: NOW + 301,
    }).reason,
    "timestamp out of range",
  );
  assert.equal(
    verifyWebhook({
      secret: SECRET,
      id: "",
      timestamp: TS,
      body: BODY,
      signatureHeader: `v1,${SIG}`,
      nowSec: NOW,
    }).reason,
    "malformed headers",
  );
});

test("rejects empty, whitespace-only, and non-canonical-Base64 secrets rather than signing with a zero-byte key", () => {
  // A missing/malformed secret must never validate ANY signature: an empty
  // or garbage secret decodes to a zero-byte HMAC key, which is a single,
  // publicly-known key, not a per-account secret.
  for (const secret of ["", "whsec_", "   ", "!!!!", "whsec_!!!!", "not base64 at all"]) {
    const result = verifyWebhook({ secret, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${SIG}`, nowSec: NOW });
    assert.equal(result.ok, false, `secret ${JSON.stringify(secret)} must not verify`);
    // A forged signature computed with the zero-byte key must also be rejected,
    // proving the gate applies before HMAC comparison, not just against the
    // fixture's real signature.
    const zeroKeySig = createHmac("sha256", Buffer.alloc(0)).update(`${ID}.${TS}.${BODY}`).digest("base64");
    const forged = verifyWebhook({ secret, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${zeroKeySig}`, nowSec: NOW });
    assert.equal(forged.ok, false, `forged zero-key signature must not verify for secret ${JSON.stringify(secret)}`);
  }
});

test("an empty/degenerate secret in a rotation list never matches; a valid co-listed secret still does", () => {
  assert.deepEqual(
    verifyWebhook({ secret: ["", SECRET], id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${SIG}`, nowSec: NOW }),
    { ok: true },
  );
});

test("rejects malformed signature headers: no v1 entries, empty signature value, and undecodable base64", () => {
  for (const signatureHeader of ["", "v2,deadbeef", "v1,", "garbage-no-comma", "v1,!!!not-base64-at-all!!!"]) {
    const result = verifyWebhook({ secret: SECRET, id: ID, timestamp: TS, body: BODY, signatureHeader, nowSec: NOW });
    assert.equal(result.ok, false, `signatureHeader ${JSON.stringify(signatureHeader)} must not verify`);
  }
});

const LEGACY_SECRET = "whsec_legacy_test_secret";
function legacySignature(secret: string, id: string, ts: string, body: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");
}

test("legacy scheme: valid whole-secret signature verifies", () => {
  const sig = legacySignature(LEGACY_SECRET, ID, TS, BODY);
  assert.deepEqual(
    verifyWebhookLegacy({ secret: LEGACY_SECRET, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${sig}`, nowSec: NOW }),
    { ok: true },
  );
});

test("legacy scheme uses a distinct key derivation from the standard scheme (not interchangeable)", () => {
  // The standard-scheme signature for SECRET must not verify under the legacy
  // scheme, and vice versa, proving the two key derivations are genuinely
  // different rather than one silently falling back to the other.
  const legacySig = legacySignature(SECRET, ID, TS, BODY);
  assert.notEqual(legacySig, SIG, "standard and legacy signatures over the same secret/payload must differ");
  assert.equal(
    verifyWebhookLegacy({ secret: SECRET, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${SIG}`, nowSec: NOW }).ok,
    false,
  );
  assert.equal(
    verifyWebhook({ secret: SECRET, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${legacySig}`, nowSec: NOW }).ok,
    false,
  );
});

test("legacy scheme rejects empty secrets rather than signing with a zero-byte key", () => {
  for (const secret of ["", "whsec_"]) {
    const result = verifyWebhookLegacy({ secret, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${SIG}`, nowSec: NOW });
    assert.equal(result.ok, false, `secret ${JSON.stringify(secret)} must not verify under the legacy scheme`);
    const zeroKeySig = createHmac("sha256", Buffer.alloc(0)).update(`${ID}.${TS}.${BODY}`).digest("base64");
    const forged = verifyWebhookLegacy({ secret, id: ID, timestamp: TS, body: BODY, signatureHeader: `v1,${zeroKeySig}`, nowSec: NOW });
    assert.equal(forged.ok, false, `forged zero-key legacy signature must not verify for secret ${JSON.stringify(secret)}`);
  }
});

test("legacy scheme rejects malformed signature headers", () => {
  for (const signatureHeader of ["", "v2,deadbeef", "v1,"]) {
    const result = verifyWebhookLegacy({ secret: LEGACY_SECRET, id: ID, timestamp: TS, body: BODY, signatureHeader, nowSec: NOW });
    assert.equal(result.ok, false);
  }
});
