import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerResearchTools, type ResearchServices } from "../src/research-tools.ts";

function setupTools() {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const recallCalls: unknown[] = [];

  const pi = {
    registerTool(def: ToolDefinition<any, any>) {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;

  const services = {
    recall: {
      async recall(input: unknown) {
        recallCalls.push(input);
        return { text: "ok", details: {} };
      },
    },
  } as unknown as ResearchServices;

  registerResearchTools(pi, () => services);
  return { tools, recallCalls };
}

test("web_recall schema exposes optional within, since, and until string parameters with minLength 1", () => {
  const { tools } = setupTools();
  const webRecall = tools.get("web_recall");
  assert.ok(webRecall, "web_recall tool should be registered");

  const props = webRecall.parameters.properties;
  for (const existing of ["handle", "query", "reference", "kinds", "limit", "cursor", "offset", "max_chars"]) {
    assert.ok(props[existing], `expected existing parameter ${existing}`);
  }

  for (const name of ["within", "since", "until"] as const) {
    const schema = props[name];
    assert.ok(schema, `expected parameter ${name}`);
    assert.equal(schema.type, "string", `${name} should be a string`);
    assert.equal(schema.minLength, 1, `${name} should have minLength: 1`);
    assert.ok(!webRecall.parameters.required?.includes(name), `${name} should be optional`);
  }
});

test("web_recall execute accepts and forwards within, since, and until to recall.recall", async () => {
  const { tools, recallCalls } = setupTools();
  const webRecall = tools.get("web_recall")!;

  const cases = [
    { within: "24h" },
    { query: "locks", since: "2026-11-01", until: "2026-11-20" },
    { within: "session", query: "locks" },
  ];

  for (const params of cases) {
    await webRecall.execute("call-1", params, undefined, undefined, {} as any);
  }

  assert.equal(recallCalls.length, cases.length);
  assert.deepEqual(recallCalls[0], { within: "24h", kinds: undefined });
  assert.deepEqual(recallCalls[1], { query: "locks", since: "2026-11-01", until: "2026-11-20", kinds: undefined });
  assert.deepEqual(recallCalls[2], { within: "session", query: "locks", kinds: undefined });
});

test("web_recall execute still rejects unknown arguments", async () => {
  const { tools, recallCalls } = setupTools();
  const webRecall = tools.get("web_recall")!;

  await assert.rejects(
    () => webRecall.execute("call-bad", { bogus: true }, undefined, undefined, {} as any),
    /web_recall does not accept bogus/,
  );
  assert.equal(recallCalls.length, 0);
});
