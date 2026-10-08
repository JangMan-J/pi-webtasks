import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvText, applyEnv, applyAliases } from "../src/env.ts";

test("parseEnvText reads KEY=value lines, skipping blanks, comments and export prefixes", () => {
  const text = [
    "# a comment",
    "",
    "PARALLEL_API_KEY=abc123",
    'export PARALLEL_WEBHOOK_KEY="quoted value"',
    "PARALLEL_ADMIN_KEY='single quoted'",
    "TRAILING=value # inline comment",
  ].join("\n");
  assert.deepEqual(parseEnvText(text), {
    PARALLEL_API_KEY: "abc123",
    PARALLEL_WEBHOOK_KEY: "quoted value",
    PARALLEL_ADMIN_KEY: "single quoted",
    TRAILING: "value",
  });
});

test("applyEnv sets PIPARA_* aliases without overriding an already-set variable", () => {
  const env: Record<string, string | undefined> = { PIPARA_API_KEY: "existing" };
  applyEnv({ PARALLEL_API_KEY: "from-file", PARALLEL_WEBHOOK_KEY: "wh-secret" }, env);
  assert.equal(env.PIPARA_API_KEY, "existing", "real env wins over the file");
  assert.equal(env.PARALLEL_API_KEY, "from-file");
  assert.equal(env.PIPARA_WEBHOOK_SECRET, "wh-secret", "alias set when target was unset");
});

test("explicit empty settings disable file defaults and aliases use the real environment", () => {
  const env = { PIPARA_WEBHOOK_DIR: "", PIPARA_WEBHOOK_SECRET: "", PARALLEL_API_KEY: "from-environment" } as Record<string, string | undefined>;
  applyEnv({ PIPARA_WEBHOOK_DIR: "/production/inbox", PARALLEL_WEBHOOK_KEY: "file-secret", PARALLEL_API_KEY: "from-file" }, env);
  assert.equal(env.PIPARA_WEBHOOK_DIR, "");
  assert.equal(env.PIPARA_WEBHOOK_SECRET, "");
  assert.equal(env.PIPARA_API_KEY, "from-environment");
});

test("applyAliases maps Parallel's own names from the real environment with no key file", () => {
  const env: Record<string, string | undefined> = { PARALLEL_API_KEY: "from-shell", PARALLEL_WEBHOOK_KEY: "wh-shell" };
  applyAliases(env);
  assert.equal(env.PIPARA_API_KEY, "from-shell");
  assert.equal(env.PIPARA_WEBHOOK_SECRET, "wh-shell");
});

test("deployed credential names win over legacy aliases and file defaults", () => {
  const env: Record<string, string | undefined> = {
    _PARALLEL_API_KEY: "deployed-test-key",
    PARALLEL_API_KEY: "legacy-test-key",
    PARALLEL_WEBHOOK_KEY: "deployed-test-signing-key",
  };
  applyAliases(env);
  applyEnv({ PARALLEL_API_KEY: "file-test-key", PARALLEL_WEBHOOK_KEY: "file-test-signing-key" }, env);
  assert.equal(env.PIPARA_API_KEY, "deployed-test-key");
  assert.equal(env.PIPARA_WEBHOOK_SECRET, "deployed-test-signing-key");
});

test("applyAliases never overrides a set PIPARA_* value, including an explicit empty one", () => {
  const env: Record<string, string | undefined> = {
    PARALLEL_API_KEY: "natural",
    PIPARA_API_KEY: "explicit",
    PARALLEL_WEBHOOK_KEY: "wh",
    PIPARA_WEBHOOK_SECRET: "",
  };
  applyAliases(env);
  assert.equal(env.PIPARA_API_KEY, "explicit");
  assert.equal(env.PIPARA_WEBHOOK_SECRET, "", "empty means deliberately disabled");
});

test("applyEnv leaves unrelated keys (e.g. PARALLEL_ADMIN_KEY) untouched with no alias", () => {
  const env: Record<string, string | undefined> = {};
  applyEnv({ PARALLEL_ADMIN_KEY: "adm" }, env);
  assert.equal(env.PARALLEL_ADMIN_KEY, "adm");
  assert.equal(Object.keys(env).length, 1);
});
