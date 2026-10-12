import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionDir, packageDir, setup, textOf } from "./helpers/test-host.ts";

const pi = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);

test("Pi 1.1 exposes advanced submission only through codemode and executes it through the native tool pipeline", {
  skip: typeof pi.createCodemodeExtension !== "function" ? "Set PI_PACKAGE_DIR to Pi >=1.1 to verify native codemode" : false,
}, async t => {
  const h = await setup(t, call => {
    if (call.path === "/v1/tasks/groups") return Response.json({ taskgroup_id: "tg_native" });
    if (call.method === "POST" && call.path.endsWith("/runs")) return Response.json({ run_ids: ["run_native"] });
    return new Response("", { headers: { "Content-Type": "text/event-stream" } });
  });
  const settingsManager = pi.SettingsManager.inMemory({ defaultTools: ["+codemode"] });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: h.dir, agentDir: join(h.dir, "agent"), settingsManager,
    additionalExtensionPaths: [join(extensionDir, "src/index.ts")],
    extensionFactories: [pi.createCodemodeExtension({ mode: "on" })],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await pi.createAgentSession({
    cwd: h.dir, agentDir: join(h.dir, "agent"), settingsManager, resourceLoader,
    sessionManager: pi.SessionManager.inMemory(h.dir),
  });
  try {
    await session.bindExtensions({});
    assert.ok(!session.getActiveToolNames().includes("webtasks_submit"));
    assert.ok(session.getCallableToolNames().includes("webtasks_submit"));
    assert.equal(session.getAllTools().find((tool: any) => tool.name === "webtasks_submit").exposure, "codemode");
    assert.ok(session.systemPrompt.includes(join(extensionDir, "docs/advanced-sdk.md")));
    const active = session.getActiveToolNames();
    session.setActiveToolsByName(["deep_search"]);
    assert.match(session.systemPrompt, /use webtasks_submit through codemode/, "deep_search carries the SDK hint without web_search");
    session.setActiveToolsByName(active);
    const codemode = session.agent.state.tools.find((tool: any) => tool.name === "codemode");
    assert.ok(codemode);
    const args = {
      code: 'text(await tools.webtasks_submit({label:"Native codemode",task:{input:"Offline test",processor:"core"}}));',
    };
    // A synthetic assistant call supplies the parent required by Pi's nested-tool pipeline.
    // No model request is made; this verifies runtime execution, not model navigation.
    session.sessionManager.appendMessage({
      role: "assistant", content: [{ type: "toolCall", id: "native-smoke", name: "codemode", arguments: args }],
      api: "openai-responses", provider: "fixture", model: "offline", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    session.refreshContext();
    const result = await codemode.execute("native-smoke", args, new AbortController().signal);
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /Research: research_[0-9a-f-]{36}/);
    assert.match(textOf(result), /Accepted/);
    assert.equal(h.calls.filter(c => c.method === "POST" && c.path.endsWith("/runs")).length, 1);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  }
});
