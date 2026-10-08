import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvText, applyEnv } from "../src/env.ts";

test("parseEnvText reads KEY=value lines, skipping blanks, comments and export prefixes", () => {
  const text = [
    "# a comment",
    "",
    "_PARALLEL_API_KEY=abc123",
    'export PARALLEL_WEBHOOK_KEY="quoted value"',
    "PARALLEL_ADMIN_KEY='single quoted'",
    "TRAILING=value # inline comment",
  ].join("\n");
  assert.deepEqual(parseEnvText(text), {
    _PARALLEL_API_KEY: "abc123",
    PARALLEL_WEBHOOK_KEY: "quoted value",
    PARALLEL_ADMIN_KEY: "single quoted",
    TRAILING: "value",
  });
});

test("key files fill only unset variables; the real environment always wins", () => {
  const env: Record<string, string | undefined> = { _PARALLEL_API_KEY: "from-environment" };
  applyEnv({ _PARALLEL_API_KEY: "from-file", PARALLEL_WEBHOOK_KEY: "file-secret" }, env);
  assert.equal(env._PARALLEL_API_KEY, "from-environment");
  assert.equal(env.PARALLEL_WEBHOOK_KEY, "file-secret");
});

test("an explicit empty setting counts as set and blocks the file value", () => {
  const env = { WEBTASKS_DIR: "", PARALLEL_WEBHOOK_KEY: "" } as Record<string, string | undefined>;
  applyEnv({ WEBTASKS_DIR: "/production/store", PARALLEL_WEBHOOK_KEY: "file-secret" }, env);
  assert.equal(env.WEBTASKS_DIR, "");
  assert.equal(env.PARALLEL_WEBHOOK_KEY, "", "empty means deliberately disabled");
});

test("key files never create names outside the provider's own and the WEBTASKS_* settings", () => {
  const env: Record<string, string | undefined> = {};
  applyEnv({ _PARALLEL_API_KEY: "key", PARALLEL_WEBHOOK_KEY: "wh", PARALLEL_ADMIN_KEY: "adm" }, env);
  assert.deepEqual(Object.keys(env).sort(), ["PARALLEL_ADMIN_KEY", "PARALLEL_WEBHOOK_KEY", "_PARALLEL_API_KEY"]);
  assert.equal(Object.keys(env).some(key => key.startsWith("PIPARA")), false);
});
