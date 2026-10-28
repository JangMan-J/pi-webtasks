import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createAnswerService } from "../src/answer-service.ts";

function fakeClient(reply?: () => unknown) {
  const calls: { path: string; body: Record<string, unknown>; headers?: Record<string, string>; maxRetries?: number }[] = [];
  const client = {
    apiKey: "secret-key",
    post: async (path: string, options?: { body?: Record<string, unknown>; headers?: Record<string, string>; maxRetries?: number }) => {
      calls.push({ path, body: options?.body ?? {}, headers: options?.headers, maxRetries: options?.maxRetries });
      if (reply) return reply();
      return {
        id: `resp_${calls.length}`,
        status: "completed",
        output_text: "The answer is 42, according to the source.",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: "The answer is 42, according to the source.",
            annotations: [{ type: "url_citation", url: "https://example.org/answer", title: "The source", start_index: 18, end_index: 41 }],
          }],
        }],
      };
    },
  };
  return { client, calls };
}

async function harness(t: import("node:test").TestContext, reply?: () => unknown) {
  const dir = await mkdtemp(resolve(tmpdir(), "answer-service-"));
  const store = new ResearchStore(dir);
  await store.init();
  await store.registerSession("s1");
  const { client, calls } = fakeClient(reply);
  const service = createAnswerService({ store, sessionId: "s1", client: async () => client });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, service, calls };
}

test("an answer is requested once, cited, stored, and readable", async t => {
  const h = await harness(t);
  const result = await h.service.answer({ question: "What is the answer?" }, { invocationId: "call-1" });

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.path, "/v1/responses");
  assert.equal(h.calls[0]!.body.model, "parallel");
  assert.equal(h.calls[0]!.body.input, "What is the answer?");
  assert.deepEqual(h.calls[0]!.body.reasoning, { effort: "low" });
  assert.equal(h.calls[0]!.body.previous_response_id, undefined);
  assert.equal(h.calls[0]!.maxRetries, 0, "a paid request is never retried");
  assert.match(result.text, /The answer is 42/);
  assert.match(result.text, /Citations: 1 source link/);
  assert.match(result.text, /continue_from/);
  assert.doesNotMatch(result.text, /secret-key/);

  const handle = String(result.details.handle);
  const stored = await h.store.readEvidence("s1", handle);
  assert.match(stored.text, /The answer is 42/);
  const citations = await h.store.citations("s1", handle);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]!.url, "https://example.org/answer");
  assert.match(citations[0]!.claim ?? "", /according to the source/, "the cited span is quoted as the claim");

  const source = await h.store.search("s1", { query: "source", kinds: ["source"] });
  assert.equal(source.hits.length, 1, "the cited source is stored as evidence too");

  const run = await h.store.run("s1", String(result.details.reference));
  assert.equal(run?.kind, "answer");
  assert.equal(run?.state, "completed");
  assert.equal(run?.provider_run_id, "resp_1");
});

test("a follow-up continues the provider conversation through the local reference", async t => {
  const h = await harness(t);
  const first = await h.service.answer({ question: "first?" }, { invocationId: "call-1" });
  const second = await h.service.answer({ question: "and then?", continue_from: String(first.details.reference) }, { invocationId: "call-2" });
  assert.equal(h.calls[1]!.body.previous_response_id, "resp_1");
  assert.equal(second.details.continued, true);

  const foreign = await h.store.beginRun({ sessionId: "s1", intentKey: "call-3", intent: {}, kind: "task", state: "accepted" });
  await assert.rejects(
    () => h.service.answer({ question: "x", continue_from: foreign.reference }, { invocationId: "call-4" }),
    /only answers can be continued/,
  );
  assert.equal(h.calls.length, 2, "an invalid continuation never reaches the provider");
});

test("a replayed invocation returns the stored answer instead of asking again", async t => {
  const h = await harness(t);
  const first = await h.service.answer({ question: "once?" }, { invocationId: "call-1" });
  const replay = await h.service.answer({ question: "once?" }, { invocationId: "call-1" });
  assert.equal(h.calls.length, 1);
  assert.equal(replay.details.replayed, true);
  assert.equal(replay.details.reference, first.details.reference);
  assert.match(replay.text, /already answered/);
  assert.match(replay.text, /The answer is 42/);
});

test("domains restrict the web search tool without becoming model-visible ids", async t => {
  const h = await harness(t);
  await h.service.answer({ question: "q", include_domains: ["example.org"], exclude_domains: ["spam.example"] }, { invocationId: "call-1" });
  assert.deepEqual(h.calls[0]!.body.tools, [
    { type: "web_search", filters: { allowed_domains: ["example.org"], blocked_domains: ["spam.example"] } },
  ]);
});

test("a definite rejection is failed; an ambiguous response is uncertain", async t => {
  const rejected = await harness(t, () => { throw Object.assign(new Error("bad request"), { status: 400, name: "BadRequestError" }); });
  await assert.rejects(() => rejected.service.answer({ question: "q" }, { invocationId: "call-1" }), /Answer did not complete: bad request/);
  assert.equal((await rejected.store.listRuns("s1"))[0]!.state, "failed");

  const broken = await harness(t, () => { throw Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }); });
  await assert.rejects(() => broken.service.answer({ question: "q" }, { invocationId: "call-1" }), /may have been processed remotely/);
  assert.equal((await broken.store.listRuns("s1"))[0]!.state, "uncertain");

  const empty = await harness(t, () => ({ id: "resp_x", status: "completed", output_text: "  " }));
  await assert.rejects(() => empty.service.answer({ question: "q" }, { invocationId: "call-1" }), /Answer was empty/);
  assert.equal((await empty.store.listRuns("s1"))[0]!.state, "failed");
});

test("input validation happens before any paid request", async t => {
  const h = await harness(t);
  await assert.rejects(() => h.service.answer({ question: "   " }, { invocationId: "call-1" }), /non-empty string/);
  await assert.rejects(() => h.service.answer({ question: "q", effort: "max" as never }, { invocationId: "call-2" }), /low, medium, or high/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.store.listRuns("s1"), []);
});
