import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createAnswerService } from "../src/answer-service.ts";

/**
 * The asynchronous answer lifecycle: the tool call returns a reference at once,
 * and the background stream settles the run with its evidence and its alert.
 */

const ANSWER_TEXT = "The answer is 42, according to the source.";
const ANNOTATION = { type: "url_citation", url: "https://example.org/answer", title: "The source", start_index: 18, end_index: 41 };

type PostCall = {
  path: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  maxRetries?: number;
  stream?: boolean;
};

/** An async iterable of parsed SSE data payloads, as the SDK's Stream yields them. */
function sseEvents(events: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return { async *[Symbol.asyncIterator]() { for (const event of events) yield event; } };
}

/** The documented event sequence of one completed answer. */
function completedEvents(id: string): Record<string, unknown>[] {
  return [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_text.delta", delta: ANSWER_TEXT },
    { type: "response.output_text.annotation.added", annotation: ANNOTATION },
    {
      type: "response.completed",
      response: {
        id, status: "completed", output_text: ANSWER_TEXT,
        output: [{ type: "message", content: [{ type: "output_text", text: ANSWER_TEXT, annotations: [ANNOTATION] }] }],
      },
    },
  ];
}

function fakeClient(reply?: (options: { signal?: AbortSignal }) => unknown) {
  const calls: PostCall[] = [];
  const client = {
    apiKey: "secret-key",
    post: async (path: string, options?: {
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      maxRetries?: number;
      timeout?: number;
      signal?: AbortSignal;
      stream?: boolean;
    }) => {
      calls.push({ path, body: options?.body ?? {}, headers: options?.headers, maxRetries: options?.maxRetries, stream: options?.stream });
      return reply ? reply({ signal: options?.signal }) : sseEvents(completedEvents(`resp_${calls.length}`));
    },
  };
  return { client, calls };
}

async function harness(t: import("node:test").TestContext, reply?: (options: { signal?: AbortSignal }) => unknown, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "answer-service-"));
  const store = new ResearchStore(dir);
  await store.init();
  await store.registerSession("s1");
  const { client, calls } = fakeClient(reply);
  const service = createAnswerService({ store, sessionId: "s1", client: async () => client, log: () => undefined, ...extra });
  t.after(async () => { await service.stop(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, service, calls };
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error("condition not reached in time");
}

test("the call returns a reference at once; the answer streams in the background and is stored cited", async t => {
  const wakes: string[] = [];
  const h = await harness(t, undefined, { onAlerts: () => wakes.push("wake") });
  const receipt = await h.service.answer({ question: "What is the answer?" }, { invocationId: "call-1" });

  assert.equal(h.calls.length, 1, "one paid request");
  assert.equal(h.calls[0]!.path, "/v1/responses");
  assert.equal(h.calls[0]!.body.model, "parallel");
  assert.equal(h.calls[0]!.body.stream, true, "the response is streamed");
  assert.deepEqual(h.calls[0]!.body.reasoning, { effort: "medium" }, "an omitted effort uses Parallel's own default");
  assert.equal(h.calls[0]!.stream, true, "the SDK decodes the event stream");
  assert.equal(h.calls[0]!.maxRetries, 0, "a paid request is never retried");
  assert.equal(h.calls[0]!.headers?.Accept, "text/event-stream");

  const reference = String(receipt.details.reference);
  assert.match(receipt.text, new RegExp(`Answer running in the background: ${reference} \\(medium effort\\)`));
  assert.match(receipt.text, /follow-up message, even after you end your turn/);
  assert.match(receipt.text, /end your turn; the answer alert brings you back/);
  assert.match(receipt.text, new RegExp(`web_answer \\{ question, continue_from: "${reference}" \\}`));
  assert.deepEqual(
    { state: receipt.details.state, replayed: receipt.details.replayed, effort: receipt.details.effort, continued: receipt.details.continued },
    { state: "submitted", replayed: false, effort: "medium", continued: false },
  );
  assert.doesNotMatch(receipt.text, /secret-key/);

  await until(async () => (await h.store.run("s1", reference))?.state === "completed");
  const run = await h.store.run("s1", reference);
  assert.equal(run?.kind, "answer");
  assert.equal(run?.provider_run_id, "resp_1", "bound from response.created");

  const report = (await h.store.search("s1", { reference, kinds: ["report"] })).hits[0]!;
  assert.match((await h.store.readEvidence("s1", report.handle)).text, /The answer is 42/);
  const citations = await h.store.citations("s1", report.handle);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]!.url, "https://example.org/answer");
  assert.match(citations[0]!.claim ?? "", /according to the source/, "the cited span is quoted as the claim");
  const source = await h.store.search("s1", { query: "source", kinds: ["source"] });
  assert.equal(source.hits.length, 1, "the cited source is stored as evidence too");

  const completion = (await h.store.alerts("s1")).find(alert => alert.kind === "completion")!;
  assert.match(completion.headline, /Answer ready: The answer is 42/);
  assert.match(completion.body ?? "", /Citations: 1 source link\(s\) across 1 site\(s\) \(top: example\.org\)/);
  assert.ok(completion.body!.includes(`Answer ${reference}.`));
  assert.deepEqual(wakes, ["wake"], "delivery woken exactly once");
});

test("domain filters send only the populated list", async t => {
  const h = await harness(t);
  await h.service.answer({ question: "q", include_domains: ["example.org"] }, { invocationId: "call-1" });
  assert.deepEqual(h.calls[0]!.body.tools, [{ type: "web_search", filters: { allowed_domains: ["example.org"] } }]);

  const other = await harness(t);
  await other.service.answer({ question: "q", exclude_domains: ["spam.example"] }, { invocationId: "call-1" });
  assert.deepEqual(other.calls[0]!.body.tools, [{ type: "web_search", filters: { blocked_domains: ["spam.example"] } }]);
});

test("input validation happens before any paid request", async t => {
  const h = await harness(t);
  await assert.rejects(() => h.service.answer({ question: "   " }, { invocationId: "call-1" }), /non-empty string/);
  await assert.rejects(() => h.service.answer({ question: "q", effort: "max" as never }, { invocationId: "call-2" }), /low, medium, or high/);
  await assert.rejects(() => h.service.answer({ question: "q", include_domains: ["https://example.org"] }, { invocationId: "call-3" }), /is not a bare domain/);
  await assert.rejects(
    () => h.service.answer({ question: "q", include_domains: ["a.com"], exclude_domains: ["b.com"] }, { invocationId: "call-4" }),
    /not both: Parallel applies only the allow list/,
  );
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.store.listRuns("s1"), []);
});

test("a replayed invocation returns the stored answer instead of asking again", async t => {
  const h = await harness(t);
  const first = await h.service.answer({ question: "once?" }, { invocationId: "call-1" });
  await until(async () => (await h.store.run("s1", String(first.details.reference)))?.state === "completed");
  const replay = await h.service.answer({ question: "once?" }, { invocationId: "call-1" });
  assert.equal(h.calls.length, 1, "the replay was never sent");
  assert.equal(replay.details.replayed, true);
  assert.equal(replay.details.reference, first.details.reference);
  assert.match(replay.text, /This question was already sent as run_\w+ .*it is not sent again/);
  assert.match(replay.text, /The answer is 42/, "the replay shows the stored answer");
});

test("a direct JSON response (a non-streaming server or mock) settles the same way", async t => {
  const h = await harness(t, () => ({
    id: "resp_json", status: "completed", output_text: ANSWER_TEXT,
    output: [{ type: "message", content: [{ type: "output_text", text: ANSWER_TEXT, annotations: [ANNOTATION] }] }],
  }));
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await h.store.run("s1", reference))?.state === "completed");
  assert.equal((await h.store.run("s1", reference))?.provider_run_id, "resp_json");
  assert.match((await h.store.readEvidence("s1", (await h.store.search("s1", { reference, kinds: ["report"] })).hits[0]!.handle)).text, /The answer is 42/);
  assert.equal((await h.store.alerts("s1")).filter(alert => alert.kind === "completion").length, 1);
});

test("a completed response without text is failed; without an id is uncertain", async t => {
  const empty = await harness(t, () => ({ id: "resp_x", status: "completed", output_text: "  " }));
  const emptyReceipt = await empty.service.answer({ question: "q" }, { invocationId: "call-1" });
  await until(async () => (await empty.store.run("s1", String(emptyReceipt.details.reference)))?.state === "failed");
  assert.equal((await empty.store.run("s1", String(emptyReceipt.details.reference)))?.error, "response carried no answer text");
  const failure = (await empty.store.alerts("s1")).find(alert => alert.kind === "failure")!;
  assert.match(failure.headline, /Answer failed: the answer came back empty/);

  const anonymous = await harness(t, () => ({ status: "completed", output_text: "An answer without an id." }));
  const anonReceipt = await anonymous.service.answer({ question: "q" }, { invocationId: "call-1" });
  await until(async () => (await anonymous.store.run("s1", String(anonReceipt.details.reference)))?.state === "uncertain");
  assert.equal((await anonymous.store.run("s1", String(anonReceipt.details.reference)))?.error, "response carried no id");
});

test("a request that fails before the stream opens settles like any paid call", async t => {
  const rejected = await harness(t, () => { throw Object.assign(new Error("bad request"), { status: 400 }); });
  await assert.rejects(() => rejected.service.answer({ question: "q" }, { invocationId: "call-1" }), /Answer did not complete: bad request/);
  assert.equal((await rejected.store.listRuns("s1"))[0]!.state, "failed");

  const broken = await harness(t, () => { throw Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }); });
  await assert.rejects(() => broken.service.answer({ question: "q" }, { invocationId: "call-1" }), /outcome is unknown \(record run_\w+\); ask again only if you still need the answer/);
  assert.equal((await broken.store.listRuns("s1"))[0]!.state, "uncertain");
});
