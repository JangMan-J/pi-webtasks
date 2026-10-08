import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import piParallelized, { applyLazyToolExposure, activateDeferredTools, DEFERRED_TOOLS } from "../../src/index.ts";
import { loadTools } from "../helpers/test-host.ts";

const DEFERRED = ["parallel_task", "parallel_group", "parallel_findall", "parallel_monitor", "parallel_memory", "parallel_account"] as const;
const CORE = ["parallel_search", "parallel_extract", "parallel_responses"] as const;
const ACTIVATOR = "parallel_tools";
const FULL = [...CORE, ACTIVATOR, ...DEFERRED, "read", "bash", "edit", "write"];

beforeEach(t => {
  const previous = process.env.PIPARA_WEBHOOK_DIR;
  process.env.PIPARA_WEBHOOK_DIR = "";
  t.after(() => {
    if (previous === undefined) delete process.env.PIPARA_WEBHOOK_DIR;
    else process.env.PIPARA_WEBHOOK_DIR = previous;
  });
});

/** Minimal ExtensionAPI stand-in for the activation actions the loader exposes. */
function activationHost(initial: string[]) {
  const state = { active: [...initial], calls: 0 };
  return {
    state,
    getActiveTools: () => [...state.active],
    setActiveTools: (names: string[]) => {
      state.active = [...names];
      state.calls += 1;
    },
  };
}

function setLazyEnv(value: string | undefined) {
  const previous = process.env.PIPARA_LAZY_TOOLS;
  if (value === undefined) delete process.env.PIPARA_LAZY_TOOLS;
  else process.env.PIPARA_LAZY_TOOLS = value;
  return () => { if (previous === undefined) delete process.env.PIPARA_LAZY_TOOLS; else process.env.PIPARA_LAZY_TOOLS = previous; };
}

function collectExtension(value: string | undefined, withActivationApi = true) {
  const previous = process.env.PIPARA_LAZY_TOOLS;
  if (value === undefined) delete process.env.PIPARA_LAZY_TOOLS;
  else process.env.PIPARA_LAZY_TOOLS = value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const host = activationHost([...CORE, ACTIVATOR, ...DEFERRED, "read", "bash"]);
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (type: string, handler: (event: any, ctx: any) => unknown) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {};
    },
    appendEntry() {},
    sendMessage() {},
  };
  if (withActivationApi) {
    pi.getActiveTools = host.getActiveTools;
    pi.setActiveTools = host.setActiveTools;
  }
  piParallelized(pi);
  if (previous === undefined) delete process.env.PIPARA_LAZY_TOOLS;
  else process.env.PIPARA_LAZY_TOOLS = previous;
  return { tools, handlers, host };
}

test("1 and true opt into deferring the six selected tools at session start", async () => {
  for (const value of ["1", "true", " TRUE "] as const) {
    const restore = setLazyEnv(value);
    try {
      const host = activationHost(FULL);
      await applyLazyToolExposure(host);
      assert.equal(host.state.calls, 1, `setActiveTools called for ${value ?? "unset"}`);
      const active = host.getActiveTools();
      for (const name of DEFERRED) assert.ok(!active.includes(name), `${name} deferred for ${value ?? "unset"}`);
      for (const name of [...CORE, ACTIVATOR, "read", "bash", "edit", "write"]) assert.ok(active.includes(name), `${name} kept for ${value ?? "unset"}`);
    } finally {
      restore();
    }
  }
});

test("unset, false, and unrecognized settings keep all nine tools active without an activator", async () => {
  for (const value of [undefined, "0", "false", " FALSE ", "", "yes"] as const) {
    const restore = setLazyEnv(value);
    try {
      const host = activationHost(FULL);
      await applyLazyToolExposure(host);
      assert.equal(host.state.calls, 0);
      assert.deepEqual(host.getActiveTools(), FULL);

      const { tools } = await loadTools();
      assert.deepEqual([...tools.keys()].filter(name => name.startsWith("parallel_")).sort(), [...CORE, ...DEFERRED].sort());
      assert.equal(tools.has(ACTIVATOR), false);
    } finally {
      restore();
    }
  }
});

test("parallel_tools selector schema uses exact deferred names and stays worth deferring", async () => {
  const restore = setLazyEnv("1");
  try {
    const { tools } = await loadTools();
    for (const name of [...CORE, ACTIVATOR, ...DEFERRED]) assert.ok(tools.has(name), `${name} must be registered when lazy exposure is available`);
    const definition: any = tools.get(ACTIVATOR);
    assert.deepEqual(definition.promptGuidelines, []);
    assert.match(definition.description, /needed deferred tool is absent/);
    assert.match(definition.description, /parallel_search, parallel_extract, and parallel_responses need no activation/);
    assert.doesNotMatch(definition.description, /\{\}/);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.deepEqual(definition.parameters.required, ["tools"]);
    assert.equal(definition.parameters.properties.tools.minItems, 1);
    assert.deepEqual(definition.parameters.properties.tools.items.enum.sort(), [...DEFERRED].sort());

    const size = (name: string) => {
      const tool: any = tools.get(name);
      return JSON.stringify({ type: "function", function: { name, description: tool.description, parameters: tool.parameters } }).length;
    };
    const deferredChars = DEFERRED.reduce((total, name) => total + size(name), 0);
    const activatorChars = size(ACTIVATOR);
    assert.ok(activatorChars < deferredChars / 5, `selector ${activatorChars} chars must cost less than 20% of ${deferredChars} deferred chars`);
  } finally {
    restore();
  }
});

test("session_start keeps all nine tools active by default and defers only when opted in", async () => {
  for (const value of [undefined, "1"] as const) {
    const restore = setLazyEnv(value);
    try {
      const h = collectExtension(value, true);
      assert.equal(h.tools.has(ACTIVATOR), value === "1");
      for (const name of DEFERRED) assert.ok(h.tools.has(name));
      const handlers = h.handlers.get("session_start") ?? [];
      assert.ok(handlers.length > 0);
      for (const handler of handlers) await handler({}, {});
      const active = h.host.getActiveTools();
      assert.equal(h.host.state.calls, value === "1" ? 1 : 0);
      for (const name of DEFERRED) assert.equal(active.includes(name), value !== "1", `${name} exposure for ${value ?? "unset"}`);
      for (const name of [...CORE, "read", "bash"]) assert.ok(active.includes(name), `${name} remains active`);
      if (value === "1") assert.ok(active.includes(ACTIVATOR));
      for (const name of DEFERRED) assert.ok(h.tools.has(name), `${name} remains registered`);
    } finally {
      restore();
    }
  }
});

test("hosts without activation APIs keep all tools even when lazy mode is requested", async () => {
  const restore = setLazyEnv("1");
  try {
    const h = collectExtension("1", false);
    assert.equal(h.tools.has(ACTIVATOR), false);
    assert.deepEqual([...h.tools.keys()].filter(name => name.startsWith("parallel_")).sort(), [...CORE, ...DEFERRED].sort());
    for (const handler of h.handlers.get("session_start") ?? []) await handler({}, {});
    await applyLazyToolExposure({});
    assert.deepEqual(await activateDeferredTools({}, ["parallel_task"]), []);
  } finally {
    restore();
  }
});

test("selector activation is partial, multi-tool, duplicate-safe, and preserves unrelated active tools", async () => {
  const host = activationHost([...CORE, ACTIVATOR, "read", "bash"]);
  assert.deepEqual(await activateDeferredTools(host, ["parallel_task"]), ["parallel_task"]);
  assert.ok(host.getActiveTools().includes("parallel_task"));
  assert.equal(host.getActiveTools().includes("parallel_group"), false);
  assert.ok(host.getActiveTools().includes("read"));

  assert.deepEqual(await activateDeferredTools(host, ["parallel_group", "parallel_memory", "parallel_group"]), ["parallel_group", "parallel_memory"]);
  assert.deepEqual(await activateDeferredTools(host, ["parallel_task", "parallel_group"]), []);
  assert.equal(new Set(host.getActiveTools()).size, host.getActiveTools().length);
  assert.equal(host.getActiveTools().includes("bash"), true);
});

test("parallel_tools validates malformed and unknown calls before changing active tools", async () => {
  const restore = setLazyEnv("1");
  try {
    const h = collectExtension("1", true);
    await (h.tools.get(ACTIVATOR).execute("test", { tools: ["parallel_task"] }) as Promise<any>);
    assert.ok(h.host.getActiveTools().includes("parallel_task"));
    const before = h.host.getActiveTools();
    for (const params of [{}, { tools: [] }, { tools: "parallel_task" }, { tools: ["parallel_nope"] }, { tools: [3] }, { tools: ["parallel_group"], extra: true }]) {
      await assert.rejects(() => h.tools.get(ACTIVATOR).execute("test", params), /parallel_tools|unknown deferred Parallel tool/);
      assert.deepEqual(h.host.getActiveTools(), before);
    }
  } finally {
    restore();
  }
});

test("exported deferred list matches the tested set", () => {
  assert.deepEqual([...DEFERRED_TOOLS].sort(), [...DEFERRED].sort());
});

test("deferred set is exactly the six non-core research tools", async () => {
  const restore = setLazyEnv("1");
  try {
    const { tools } = await loadTools();
    const registered = [...tools.keys()].filter(name => name.startsWith("parallel_"));
    assert.deepEqual([...DEFERRED].sort(), registered.filter(name => DEFERRED.includes(name as any)).sort());
    assert.equal(registered.length, 10, "nine research tools plus the activator");
  } finally {
    restore();
  }
});
