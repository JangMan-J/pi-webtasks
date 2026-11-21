import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createAnswerService } from "../src/answer-service.ts";

/**
 * The answer sidecar's stream matrix: how SSE events (or a direct object) settle
 * the run, its evidence, and its alert — and how the ways a stream can die settle
 * uncertain, since the Responses API has no retrieve-by-id.
 */

const ANNOTATION = { type: "url_citation", url: "https://example.org/answer", title: "The source" };

/** An async iterable of parsed SSE data payloads, as the SDK's Stream yields them. */
function sseEvents(events: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return { async *[Symbol.asyncIterator]() { for (const event of events) yield event; } };
}

function fakeClient(reply?: (options: { signal?: AbortSignal }) => unknown) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const client = {
    apiKey: "secret-key",
    post: async (path: string, options?: { body?: Record<string, unknown>; signal?: AbortSignal }) => {
      calls.push({ path, body: options?.body ?? {} });
      return reply ? reply({ signal: options?.signal }) : sseEvents([]);
    },
  };
  return { client, calls };
}

async function harness(t: import("node:test").TestContext, reply: (options: { signal?: AbortSignal }) => unknown, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "answer-sidecar-"));
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

async function runState(h: Awaited<ReturnType<typeof harness>>, reference: string): Promise<string | undefined> {
  return (await h.store.run("s1", reference))?.state;
}

test("deltas and annotation events are the fallback when the terminal response carries no text", async t => {
  const h = await harness(t, () => sseEvents([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_text.delta", delta: "The assembled " },
    { type: "response.output_text.delta", delta: "answer text." },
    { type: "response.output_text.annotation.added", annotation: ANNOTATION },
    { type: "response.completed", response: { id: "resp_1", status: "completed" } },
  ]));
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "completed");

  const report = (await h.store.search("s1", { reference, kinds: ["report"] })).hits[0]!;
  assert.equal((await h.store.readEvidence("s1", report.handle)).text, "The assembled answer text.");
  const citations = await h.store.citations("s1", report.handle);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]!.url, "https://example.org/answer", "the annotation became a stored source and citation");
});

test("an incomplete response is failed, keeps its partial text, and says so", async t => {
  const h = await harness(t, () => sseEvents([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.incomplete",
      response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "Partial draft." },
    },
  ]));
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "failed");

  const run = await h.store.run("s1", reference);
  assert.equal(run?.error, "incomplete: max_output_tokens");
  const report = (await h.store.search("s1", { reference, kinds: ["report"] })).hits[0]!;
  assert.equal((await h.store.readEvidence("s1", report.handle)).text, "Partial draft.", "the partial answer is stored");
  const failure = (await h.store.alerts("s1")).find(alert => alert.kind === "failure")!;
  assert.match(failure.headline, /Answer incomplete: max_output_tokens/);
  assert.match(failure.body ?? "", /A partial answer is stored under the reference\./);
});

test("a failed response settles failed with the provider's error", async t => {
  const h = await harness(t, () => sseEvents([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.failed", response: { id: "resp_1", status: "failed", error: { message: "provider exploded" } } },
  ]));
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "failed");
  assert.equal((await h.store.run("s1", reference))?.error, "provider exploded");
  const failure = (await h.store.alerts("s1")).find(alert => alert.kind === "failure")!;
  assert.match(failure.headline, /Answer failed: provider exploded/);
});

test("a cancelled direct response settles cancelled", async t => {
  const h = await harness(t, () => ({ id: "resp_c", status: "cancelled" }));
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "cancelled");
  const failure = (await h.store.alerts("s1")).find(alert => alert.kind === "failure")!;
  assert.match(failure.headline, /Answer was cancelled/);
});

test("a stream that ends without a terminal event is uncertain and never alerts", async t => {
  let wakes = 0;
  const h = await harness(t, () => sseEvents([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_text.delta", delta: "a partial thought" },
  ]), { onAlerts: () => { wakes++; } });
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "uncertain");
  assert.match((await h.store.run("s1", reference))?.error ?? "", /stream ended before Parallel sent a terminal event/);
  assert.equal((await h.store.alerts("s1")).length, 0);
  assert.equal(wakes, 0);
});

test("a stream that throws mid-answer is uncertain with the error", async t => {
  const throwing: AsyncIterable<Record<string, unknown>> = {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.created", response: { id: "resp_1", status: "in_progress" } };
      throw new Error("socket exploded");
    },
  };
  const h = await harness(t, () => throwing);
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "uncertain");
  const run = await h.store.run("s1", reference);
  assert.match(run?.error ?? "", /socket exploded/);
  assert.equal(run?.provider_run_id, "resp_1", "what the stream said before dying is kept");
});

test("a second terminal event in the stream changes nothing", async t => {
  let wakes = 0;
  const completed = { type: "response.completed", response: { id: "resp_1", status: "completed", output_text: "Done." } };
  const h = await harness(t, () => sseEvents([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    completed,
    completed,
  ]), { onAlerts: () => { wakes++; } });
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await runState(h, reference)) === "completed");
  assert.equal((await h.store.alerts("s1")).filter(alert => alert.kind === "completion").length, 1);
  assert.equal(wakes, 1);
});

test("concurrent answers run independent sidecars", async t => {
  let n = 0;
  const h = await harness(t, () => {
    n++;
    const id = `resp_${n}`;
    return sseEvents([
      { type: "response.created", response: { id, status: "in_progress" } },
      { type: "response.completed", response: { id, status: "completed", output_text: `Answer ${n}.` } },
    ]);
  });
  const a = await h.service.answer({ question: "a?" }, { invocationId: "call-1" });
  const b = await h.service.answer({ question: "b?" }, { invocationId: "call-2" });
  const refA = String(a.details.reference);
  const refB = String(b.details.reference);
  await until(async () => (await runState(h, refA)) === "completed" && (await runState(h, refB)) === "completed");
  const runA = await h.store.run("s1", refA);
  const runB = await h.store.run("s1", refB);
  assert.notEqual(runA?.provider_run_id, runB?.provider_run_id);
  assert.equal((await h.store.readEvidence("s1", (await h.store.search("s1", { reference: refA, kinds: ["report"] })).hits[0]!.handle)).text, "Answer 1.");
  assert.equal((await h.store.readEvidence("s1", (await h.store.search("s1", { reference: refB, kinds: ["report"] })).hits[0]!.handle)).text, "Answer 2.");
});
