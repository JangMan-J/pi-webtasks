import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvText, applyEnv } from "../src/env.ts";

test("parseEnvText reads KEY=value lines, skipping blanks, comments and export prefixes", () => {
  const text = [
    "# a comment",
    "",
    "_PARALLEL_API_KEY=abc123",
    'export WEBTASKS_TASK_PROCESSOR="quoted value"',
    "WEBTASKS_DIR='single quoted'",
    "TRAILING=value # inline comment",
  ].join("\n");
  assert.deepEqual(parseEnvText(text), {
    _PARALLEL_API_KEY: "abc123",
    WEBTASKS_TASK_PROCESSOR: "quoted value",
    WEBTASKS_DIR: "single quoted",
    TRAILING: "value",
  });
});

test("key files fill only unset variables; the real environment always wins", () => {
  const env: Record<string, string | undefined> = { WEBTASKS_DIR: "from-environment" };
  applyEnv({ WEBTASKS_DIR: "from-file", WEBTASKS_TASK_PROCESSOR: "pro" }, env);
  assert.equal(env.WEBTASKS_DIR, "from-environment");
  assert.equal(env.WEBTASKS_TASK_PROCESSOR, "pro");
});

test("an explicit empty setting counts as set and blocks the file value", () => {
  const env = { WEBTASKS_DIR: "" } as Record<string, string | undefined>;
  applyEnv({ WEBTASKS_DIR: "/production/store" }, env);
  assert.equal(env.WEBTASKS_DIR, "", "empty means deliberately unset");
});

test("applyEnv adds exactly the names it is given", () => {
  const env: Record<string, string | undefined> = {};
  applyEnv({ WEBTASKS_DIR: "/store", WEBTASKS_SWEEP_MS: "1000" }, env);
  assert.deepEqual(Object.keys(env).sort(), ["WEBTASKS_DIR", "WEBTASKS_SWEEP_MS"]);
});
