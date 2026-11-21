import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createAnswerService } from "../src/answer-service.ts";

/**
 * The answer sidecar's lifecycle: replay while a stream is open, shutdown and
 * timeout settling uncertain, the footer status lane held until settlement,
 * and the continuation rules.
 */

const ANSWER_TEXT = "The answer is 42, according to the source.";
const ANNOTATION = { type: "url_citation", url: "https://example.org/answer", title: "The source" };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolveGate => { open = resolveGate; });
  return { opened, open };
}

/** A stream that announces the response, then waits for the gate (or an abort) before completing. */
function sseGated(g: { opened: Promise<void> }, signal?: AbortSignal): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.created", response: { id: "resp_slow", status: "in_progress" } };
      await Promise.race([
        g.opened,
        new Promise<void>(resolveWait => {
          if (signal?.aborted) return resolveWait();
          signal?.addEventListener("abort", () => resolveWait(), { once: true });
        }),
      ]);
      if (signal?.aborted) return; // the SDK's stream ends cleanly on abort
      yield {
        type: "response.completed",
        response: {
          id: "resp_slow", status: "completed", output_text: ANSWER_TEXT,
          output: [{ type: "message", content: [{ type: "output_text", text: ANSWER_TEXT, annotations: [ANNOTATION] }] }],
        },
      };
    },
  };
}

function fakeClient(reply?: (options: { signal?: AbortSignal }) => unknown) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const client = {
    apiKey: "secret-key",
    post: async (path: string, options?: { body?: Record<string, unknown>; signal?: AbortSignal }) => {
      calls.push({ path, body: options?.body ?? {} });
      return reply ? reply({ signal: options?.signal }) : undefined;
    },
  };
  return { client, calls };
}

async function harness(t: import("node:test").TestContext, reply?: (options: { signal?: AbortSignal }) => unknown, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "answer-lifecycle-"));
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

test("a replay while the answer is still streaming shows the open run and never pays twice", async t => {
  const g = gate();
  const h = await harness(t, ({ signal }) => sseGated(g, signal));
  const first = await h.service.answer({ question: "slow?" }, { invocationId: "call-1" });
  const reference = String(first.details.reference);

  const replay = await h.service.answer({ question: "slow?" }, { invocationId: "call-1" });
  assert.equal(replay.details.replayed, true);
  assert.equal(replay.details.reference, reference);
  assert.match(replay.text, /This question was already sent as run_\w+ \(state: (submitting|accepted)\); it is not sent again/);
  assert.equal(h.calls.length, 1, "no second paid request");

  g.open();
  await until(async () => (await h.store.run("s1", reference))?.state === "completed");
});

test("stop() aborts an in-flight stream and settles it uncertain before the store closes", async t => {
  const never = gate(); // never opened
  const h = await harness(t, ({ signal }) => sseGated(never, signal));
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(() => h.calls.length === 1);

  await h.service.stop();
  const run = await h.store.run("s1", reference);
  assert.equal(run?.state, "uncertain", "settled before stop() resolved");
  assert.equal(run?.error, "interrupted before the result was stored");
  assert.equal((await h.store.alerts("s1")).length, 0, "an interrupted answer does not alert");
});

test("a hung stream is stopped after streamTimeoutMs and settles uncertain", async t => {
  const never = gate();
  const h = await harness(t, ({ signal }) => sseGated(never, signal), { streamTimeoutMs: 25 });
  const receipt = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  const reference = String(receipt.details.reference);
  await until(async () => (await h.store.run("s1", reference))?.state === "uncertain");
  assert.match((await h.store.run("s1", reference))?.error ?? "", /exceeded .* and was stopped/);
});

test("the status lane stays open until the sidecar settles, not the tool call", async t => {
  const status = {
    lanes: [] as string[],
    ends: 0,
    begin(lane: string) {
      this.lanes.push(lane);
      let ended = false;
      return () => {
        if (!ended) {
          ended = true;
          this.ends++;
        }
      };
    },
  };
  const g = gate();
  const h = await harness(t, ({ signal }) => sseGated(g, signal), { status: () => status });
  const first = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  assert.deepEqual(status.lanes, ["answer"], "the lane opens when the stream opens");
  assert.equal(status.ends, 0, "the lane is still open after the tool call returned");

  const replay = await h.service.answer({ question: "q" }, { invocationId: "call-1" });
  assert.equal(replay.details.replayed, true);
  assert.deepEqual(status.lanes, ["answer"], "a replay opens no second lane");

  g.open();
  await until(async () => (await h.store.run("s1", String(first.details.reference)))?.state === "completed");
  await until(() => status.ends === 1, 1000);
});

test("continue_from requires a completed answer", async t => {
  const g = gate();
  const h = await harness(t, ({ signal }) => sseGated(g, signal));
  const first = await h.service.answer({ question: "first?" }, { invocationId: "call-1" });
  const reference = String(first.details.reference);
  g.open();
  await until(async () => (await h.store.run("s1", reference))?.state === "completed");

  const second = await h.service.answer({ question: "and then?", continue_from: reference }, { invocationId: "call-2" });
  assert.equal(second.details.continued, true);
  await until(() => h.calls.length === 2);
  assert.equal(h.calls[1]!.body.previous_response_id, "resp_slow", "the stored provider id continues the conversation");

  const bound = await h.store.beginRun({ sessionId: "s1", intentKey: "call-bound", intent: {}, kind: "answer", state: "accepted" as never });
  await h.store.bindProviderRun({ sessionId: "s1", reference: bound.reference, providerRunId: "resp_running" });
  await assert.rejects(
    () => h.service.answer({ question: "x", continue_from: bound.reference }, { invocationId: "call-3" }),
    /has no completed answer to continue from \(state: accepted\)/,
    "a bound-but-unfinished answer is not continuable",
  );

  const task = await h.store.beginRun({ sessionId: "s1", intentKey: "call-task", intent: {}, kind: "task", state: "accepted" as never });
  await assert.rejects(() => h.service.answer({ question: "x", continue_from: task.reference }, { invocationId: "call-4" }), /is not an earlier web_answer/);
  await assert.rejects(() => h.service.answer({ question: "x", continue_from: "run_missing" }, { invocationId: "call-5" }), /is not a research record/);
  assert.equal(h.calls.length, 2, "rejected continuations never reach the provider");
});

test("continue_from resolves an earlier answer run across sessions", async t => {
  const h = await harness(t);
  await h.store.registerSession("s0");
  const prior = await h.store.beginRun({ sessionId: "s0", intentKey: "call-s0", intent: {}, kind: "answer", state: "accepted" as never });
  await h.store.completeRun({ sessionId: "s0", reference: prior.reference, state: "completed", providerRunId: "resp_s0", rawResult: { id: "resp_s0" } });

  const view = Object.create(h.store) as ResearchStore;
  const lookups: { options?: { crossSession?: boolean } }[] = [];
  (view as unknown as { run: (sid: string, ref: string, opts?: { crossSession?: boolean }) => Promise<unknown> }).run = async (sid, ref, opts) => {
    lookups.push({ options: opts });
    return (await (h.store.run as (s: string, r: string, o?: { crossSession?: boolean }) => Promise<unknown>)(sid, ref, opts))
      ?? (opts?.crossSession ? await h.store.run("s0", ref) : undefined);
  };

  const g = gate();
  const { client, calls } = fakeClient(({ signal }) => sseGated(g, signal));
  const s1 = createAnswerService({ store: view, sessionId: "s1", client: async () => client, log: () => undefined });
  t.after(() => s1.stop());
  const result = await s1.answer({ question: "follow-up?", continue_from: prior.reference }, { invocationId: "call-s1" });
  assert.equal(lookups[0]?.options?.crossSession, true);
  assert.equal(result.details.continued, true);
  await until(() => calls.length === 1);
  assert.equal(calls[0]!.body.previous_response_id, "resp_s0");
  g.open();
});
