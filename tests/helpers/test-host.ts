import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";

export const extensionDir = fileURLToPath(new URL("../../", import.meta.url));
let packageDir = process.env.PI_PACKAGE_DIR || dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
while (!existsSync(resolve(packageDir, "package.json")) || JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
  const parent = dirname(packageDir);
  if (parent === packageDir) throw new Error("Set PI_PACKAGE_DIR to the installed Pi package directory");
  packageDir = parent;
}
export { packageDir };
export type SentMessage = { message: unknown; options: unknown };
export type AppendedEntry = { customType: string; data: unknown };

/**
 * Real Pi loader (`dist/core/extensions/loader.js`), not a hand-rolled stub:
 * exercises the actual `pi.on()`/`pi.registerTool()` registration path an
 * installed extension goes through. `extension.handlers` is the loader's own
 * `Map<eventType, HandlerFn[]>` (see extensions/types.d.ts `Extension`) --
 * capturing it lets tests fire session_start/session_shutdown through the
 * same dispatch the real ExtensionRunner.emit() uses (see runner.js emit()),
 * instead of only exercising tool execute() in isolation.
 */
export async function loadTools() {
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(resolve(packageDir, "dist/core/extensions/loader.js")).href);
  const manifest = JSON.parse(readFileSync(resolve(extensionDir, "package.json"), "utf8"));
  const sent: SentMessage[] = [];
  const entries: AppendedEntry[] = [];
  // Real action stubs throw ("Extension runtime not initialized") until
  // replaced. Model the session tool loadout because lazy exposure calls
  // getActiveTools()/setActiveTools() during session_start; every unrelated
  // action stays the throwing stub so an unexpected call still fails loudly.
  const runtime = createExtensionRuntime();
  let activeTools: string[] = [];
  runtime.sendMessage = (message: unknown, options: unknown) => { sent.push({ message, options }); };
  runtime.appendEntry = (customType: string, data: unknown) => { entries.push({ customType, data }); };
  runtime.getActiveTools = () => [...activeTools];
  runtime.setActiveTools = (names: string[]) => { activeTools = [...names]; };
  const loaded = await loadExtensions(manifest.pi.extensions.map((entry: string) => resolve(extensionDir, entry)), extensionDir, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.equal(extension.commands.size, 0, "the extension registers no commands");
  // Providers the extension registered (queued until Pi binds the runtime; the harness never binds it).
  const nativeProviders = runtime.pendingNativeProviderRegistrations.map((registration: any) => registration.provider);
  activeTools = [...extension.tools].filter(([, tool]: any) =>
    tool.definition.exposure === undefined || ["direct", "model-only"].includes(tool.definition.exposure),
  ).map(([name]: any) => name);
  const { buildSystemPromptSections } = await import(pathToFileURL(resolve(packageDir, "dist/core/system-prompt.js")).href);
  return {
    tools: new Map([...extension.tools].map(([name, tool]: any) => [name, tool.definition])),
    commands: extension.commands,
    handlers: extension.handlers as Map<string, ((event: any, ctx: any) => unknown)[]>,
    activeTools: () => [...activeTools],
    sent, entries, nativeProviders,
    buildSystemPromptSections,
  };
}

/**
 * Imports the extension entry natively with a minimal recording host. Used only where a test
 * must inject a fault into the same module instance (the Pi loader gives the extension its own).
 */
export async function loadDirect() {
  const sent: SentMessage[] = [];
  const entries: AppendedEntry[] = [];
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const nativeProviders: any[] = [];
  const pi = {
    on: (type: string, fn: (event: any, ctx: any) => unknown) => { handlers.set(type, [...(handlers.get(type) ?? []), fn]); },
    registerTool: (def: any) => { tools.set(def.name, def); },
    registerCommand: (name: string, def: any) => { commands.set(name, def); },
    registerProvider: (provider: any) => { nativeProviders.push(provider); },
    sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
  };
  const { default: extension } = await import(pathToFileURL(resolve(extensionDir, "src/index.ts")).href);
  extension(pi);
  assert.equal(commands.size, 0, "the extension registers no commands");
  return { tools, commands, handlers, sent, entries, nativeProviders, activeTools: () => [...tools].filter(([, tool]) =>
    tool.exposure === undefined || ["direct", "model-only"].includes(tool.exposure),
  ).map(([name]) => name), buildSystemPromptSections: undefined };
}

/**
 * Mirrors ExtensionRunner.emit()'s basic (non-cancelling) dispatch: run every
 * handler registered for `type`, in registration order, awaiting each in
 * turn (see runner.js emit()). Sufficient for session_start/session_shutdown,
 * which never return a cancel result.
 */
export async function fire(handlers: Map<string, ((event: any, ctx: any) => unknown)[]>, type: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
}

/** A stored credential, as Pi's auth.json holds it. Tests change the shared store between calls. */
export type HostCredential =
  | { type: "api_key"; key?: string }
  | { type: "oauth"; access: string; refresh: string; expires: number };

/**
 * The part of Pi's ModelRegistry that the extension uses, dispatched as Pi's pi-ai resolveProviderAuth does:
 * a stored oauth credential goes only to `auth.oauth.toAuth`; a stored api_key (or none) goes to
 * `auth.apiKey.resolve`. A failure reports no key, as Pi does. Expiry is not modelled: tests use the
 * long-lived sentinel, which Pi never refreshes.
 */
export function registryFor(providers: any[], credentials: Record<string, HostCredential | undefined>) {
  return {
    async getApiKeyForProvider(providerId: string): Promise<string | undefined> {
      const provider = providers.find(candidate => candidate.id === providerId);
      const stored = credentials[providerId];
      try {
        if (stored?.type === "oauth") {
          if (!provider?.auth?.oauth) return undefined;
          return (await provider.auth.oauth.toAuth(stored)).apiKey;
        }
        const method = provider?.auth?.apiKey;
        if (!method) return undefined;
        const authContext = {
          env: async (name: string) => process.env[name]?.trim() || undefined,
          fileExists: async () => false,
        };
        const resolved = await method.resolve({ ctx: authContext, credential: stored, signal: new AbortController().signal });
        return resolved?.auth?.apiKey;
      } catch {
        return undefined;
      }
    },
  };
}

export function context(cwd: string, confirm = async (_title: string, _body: string) => true, sessionId = "test-session") {
  return {
    cwd, hasUI: true, mode: "tui" as const, model: { provider: "test", id: "context-control" },
    sessionManager: { getSessionId: () => sessionId },
    ui: { confirm, notify() {}, setStatus(_key: string, _text: string | undefined) {} },
  };
}

/** Text and details of a tool result. */
export function textOf(result: any): string {
  return result.content.map((c: any) => c.text ?? "").join("");
}

export type Call = {
  path: string;
  query: URLSearchParams;
  method: string;
  body: any;
  signal: AbortSignal;
  headers: Headers;
  beta: string | null;
};

export type HostOptions = { sessionId?: string; storeDir?: string; direct?: boolean };

// Tests using this fixture must remain serial: HOME and fetch are process globals.
export async function setup(t: TestContext, handler: (call: Call) => Response | Promise<Response>, options: HostOptions = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "webtasks-host-"));
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  const live: { stop(): Promise<unknown> }[] = [];
  let callSeq = 0;
  t.after(async () => {
    for (const instance of live.splice(0)) await instance.stop().catch(() => undefined);
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(dir, { recursive: true, force: true });
  });
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = resolve(dir, "agent");
  process.env._PARALLEL_API_KEY = "offline-only";
  // Never inherit an installed receiver's live inbox or callback defaults. Explicit empty
  // values also block an adjacent parallel.env from enabling them.
  process.env.WEBTASKS_DIR = options.storeDir ?? "";
  const calls: Call[] = [];
  // Shared across this host's instances, as one Pi auth.json is shared across a session's reloads.
  const credentials: Record<string, HostCredential | undefined> = {};
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const raw = await request.text();
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; }
    catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    const call = {
      path: new URL(request.url).pathname, query: new URL(request.url).searchParams, method: request.method, body,
      signal: init?.signal ?? request.signal,
      headers: request.headers, beta: request.headers.get("parallel-beta"),
    };
    calls.push(call);
    return handler(call);
  };
  /** One extension instance, as Pi builds one per session start or reload. */
  async function instance(sessionId = options.sessionId ?? "session-a") {
    const loaded = (options.direct ? await loadDirect() : await loadTools()) as Awaited<ReturnType<typeof loadTools>>;
    const ctx = { ...context(dir, undefined, sessionId), modelRegistry: registryFor(loaded.nativeProviders, credentials) };
    const statusWrites: { key: string; text: string | undefined }[] = [];
    ctx.ui.setStatus = (key: string, text: string | undefined) => { statusWrites.push({ key, text }); };
    const progress: string[] = [];
    const self: any = {
      ...loaded, ctx, progress, statusWrites, sessionId,
      start: () => fire(loaded.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx),
      stop: () => fire(loaded.handlers, "session_shutdown", { type: "session_shutdown" }, ctx),
      /** Raw tool result; throws what the tool throws. Each call gets a fresh Pi tool-call id. */
      run: (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
        loaded.tools.get(name).execute(`call-${++callSeq}`, args, signal, (u: unknown) => { progress.push(JSON.stringify(u)); }, ctx),
      call: async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const result = await self.run(name, args, signal);
        return { text: textOf(result), details: result.details };
      },
    };
    live.push(self);
    return self;
  }
  const first = await instance();
  return {
    dir, calls, instance, credentials, ...first,
    inboxDir: options.storeDir ?? resolve(dir, "agent/webtasks"),
  };
}
