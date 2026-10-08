/**
 * bench/mock-provider.ts — offline test double for the real pi-ai
 * openai-completions request path (the pinned Fireworks/Kimi route shape).
 *
 * Test-only helper. It is never mounted into a benchmark run environment;
 * the observer itself (bench/observer.ts) stays self-contained.
 *
 * The model definition mirrors the installed catalog entry for
 * `fireworks/accounts/fireworks/routers/kimi-k3-fast` (pi 0.86.1 bundle).
 * `compat` is intentionally left undefined so the installed compat detection
 * decides the output-token field — the tests assert that field empirically.
 */
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

export const MOCK_MODEL = {
  id: "accounts/fireworks/routers/kimi-k3-fast",
  name: "Kimi K3 Fast",
  provider: "fireworks",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  api: "openai-completions",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 131_072,
} as any;

export interface MockCall {
  url: string;
  body: any;
  /** True when the transport was entered with an already-aborted signal. */
  abortedAtEntry: boolean;
}

export interface MockFetch {
  fetch: (url: any, init?: any) => Promise<Response>;
  calls: MockCall[];
  /** Requests that reached the transport with a live signal. */
  dispatched: number;
}

function sseBody(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) =>
    `data: ${JSON.stringify({
      id: "cmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: MOCK_MODEL.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) +
    "data: [DONE]\n\n"
  );
}

/**
 * A fetch replacement that behaves like a real transport with respect to
 * abort: a request arriving with an already-aborted signal is rejected and
 * never counted as dispatched.
 */
export function createMockFetch(replyText = "ok"): MockFetch {
  const mock: MockFetch = {
    calls: [],
    dispatched: 0,
    fetch: async (url: any, init?: any) => {
      const signal: AbortSignal | undefined = init?.signal;
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const call: MockCall = {
        url: String(url),
        body: raw ? JSON.parse(raw) : undefined,
        abortedAtEntry: signal?.aborted === true,
      };
      mock.calls.push(call);
      if (call.abortedAtEntry) {
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      }
      mock.dispatched += 1;
      return new Response(sseBody(replyText), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  };
  return mock;
}

type StreamFn = (model: any, context: any, options: any) => { result(): Promise<any> };

let cachedStream: StreamFn | undefined;

/** Load the installed pi-ai openai-completions stream function. */
export async function loadProviderStream(): Promise<StreamFn> {
  if (cachedStream) return cachedStream;
  // The package's exports map only exposes "." and a few subpaths, so resolve
  // the entry file and step to the sibling API module, like tests/helpers do.
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const module_ = resolve(dirname(new URL(entry).pathname), "api", "openai-completions.js");
  const api = await import(pathToFileURL(module_).href);
  cachedStream = api.stream as StreamFn;
  return cachedStream;
}

export interface MockRequestOptions {
  signal?: AbortSignal;
  onPayload?: (payload: any, model: any) => Promise<any> | any;
  fetch: (url: any, init?: any) => Promise<Response>;
  maxTokens?: number;
  prompt?: string;
}

/**
 * Run one chat completion through the real pi-ai serializer and stream
 * parser against the mock transport. Returns the final assistant message
 * (stopReason "stop", "aborted", or "error"); it does not throw on
 * provider-path errors.
 */
export async function runChatRequest(options: MockRequestOptions): Promise<any> {
  const stream = await loadProviderStream();
  const context = {
    systemPrompt: "bench mock system prompt",
    messages: [{ role: "user", content: options.prompt ?? "say ok", timestamp: Date.now() }],
  };
  const eventStream = stream(MOCK_MODEL, context, {
    signal: options.signal,
    onPayload: options.onPayload,
    fetch: options.fetch,
    apiKey: "offline-mock-key",
    maxRetries: 0,
    maxTokens: options.maxTokens ?? 131_072,
    cacheRetention: "none",
  });
  return eventStream.result();
}
