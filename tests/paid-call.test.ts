import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createPaidCalls, UnusableResponse, type PaidCall, type RequestOptions } from "../src/paid-call.ts";

type Client = { name: string };

async function harness(t: import("node:test").TestContext, client: () => Promise<Client> = async () => ({ name: "client" })) {
  const dir = await mkdtemp(resolve(tmpdir(), "paid-call-"));
  const store = await new ResearchStore(dir).init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const calls = createPaidCalls({ store, sessionId: "s1", client });
  const sent: { reference: string; options: RequestOptions; stateWhenSent?: string }[] = [];
  /** A call whose request is `respond`, recording what it was sent with. */
  function call<R>(invocationId: string, respond: () => R | Promise<R>, extra: Partial<PaidCall<Client, R>> = {}): PaidCall<Client, R> {
    return {
      kind: "search",
      label: "Search",
      intent: { kind: "search", query: "alpha" },
      invocation: { invocationId },
      send: async (_client, request) => {
        sent.push({ ...request, stateWhenSent: (await store.run("s1", request.reference))?.state });
        return respond();
      },
      ...extra,
    };
  }
  const state = async () => (await store.listRuns("s1"))[0]?.state;
  return { store, calls, sent, call, state };
}

/** Match the whole message the agent sees, not `String(err)` with its error name. */
const message = (pattern: RegExp) => (err: Error) => {
  assert.match(err.message, pattern);
  return true;
};

const settleAsEvidence = (response: { id: string; text: string }) => ({
  summary: response.text,
  providerRunId: response.id,
  rawResult: response,
  evidence: [{ kind: "excerpt" as const, origin: "provider_source" as const, body: response.text, title: "Alpha" }],
});

test("a call is recorded before it is sent, sent once without retries, and committed with its evidence", async t => {
  const h = await harness(t);
  const outcome = await h.calls.run(h.call("call-1", () => ({ id: "search_1", text: "alpha fact" }), { settle: settleAsEvidence }));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.stateWhenSent, "submitting", "the intent is recorded before any money is spent");
  assert.equal(h.sent[0]!.options.maxRetries, 0, "a paid request is never retried");
  assert.equal(h.sent[0]!.options.timeout, 180_000);
  assert.equal(outcome.replayed, false);
  if (outcome.replayed) return;
  assert.equal(outcome.evidence.length, 1);
  assert.match((await h.store.readEvidence("s1", outcome.evidence[0]!.handle)).text, /alpha fact/);
  const run = await h.store.run("s1", outcome.reference);
  assert.equal(run?.state, "completed");
  assert.equal(run?.provider_run_id, "search_1");
  assert.deepEqual(run?.intent, { kind: "search", query: "alpha" });
});

test("a replayed invocation returns the stored run and its evidence and is never sent again", async t => {
  const h = await harness(t);
  const first = await h.calls.run(h.call("call-1", () => ({ id: "search_1", text: "alpha fact" }), { settle: settleAsEvidence }));
  const replay = await h.calls.run(h.call("call-1", () => ({ id: "search_2", text: "should not happen" }), { settle: settleAsEvidence }));

  assert.equal(h.sent.length, 1, "the provider is asked exactly once");
  assert.equal(replay.replayed, true);
  if (!replay.replayed) return;
  assert.equal(replay.reference, first.reference);
  assert.equal(replay.run?.state, "completed");
  assert.equal(replay.hits.length, 1, "the replay sees what was stored");

  await h.calls.run(h.call("call-2", () => ({ id: "search_3", text: "a new investigation" }), { settle: settleAsEvidence }));
  assert.equal(h.sent.length, 2, "a new invocation is a new call, even with the same intent");
});

test("a missing credential fails the run with the original message and sends nothing", async t => {
  const h = await harness(t, async () => { throw new Error("Run /login, choose Parallel, and paste an API key"); });
  await assert.rejects(
    () => h.calls.run(h.call("call-1", () => ({ id: "x", text: "x" }), { settle: settleAsEvidence })),
    (err: Error) => err.message === "Run /login, choose Parallel, and paste an API key",
  );
  assert.equal(h.sent.length, 0);
  assert.equal(await h.state(), "failed", "the provider was never asked, so the outcome is known");
});

test("a 4xx is a definite rejection; anything else may have reached the provider and is uncertain", async t => {
  const failures: [string, unknown, "failed" | "uncertain"][] = [
    ["400", Object.assign(new Error("invalid request"), { status: 400 }), "failed"],
    ["404", Object.assign(new Error("not found"), { status: 404 }), "failed"],
    ["429", Object.assign(new Error("rate limited"), { status: 429 }), "failed"],
    ["408", Object.assign(new Error("request timeout"), { status: 408 }), "uncertain"],
    ["500", Object.assign(new Error("server error"), { status: 500 }), "uncertain"],
    ["503", Object.assign(new Error("unavailable"), { status: 503 }), "uncertain"],
    ["connection", Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }), "uncertain"],
    ["timeout", Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }), "uncertain"],
    ["abort", Object.assign(new Error("aborted"), { name: "APIUserAbortError" }), "uncertain"],
    ["unexpected", new TypeError("cannot read properties of undefined"), "uncertain"],
  ];
  for (const [name, error, expected] of failures) {
    const h = await harness(t);
    const pattern = expected === "failed"
      ? /^Search did not complete: .+\. Record run_[0-9a-f]{16}\.$/
      : /^Search did not complete: .+\. Its outcome is unknown \(record run_[0-9a-f]{16}\); try again only if you still need the result\.$/;
    await assert.rejects(() => h.calls.run(h.call("call-1", () => { throw error; }, { settle: settleAsEvidence })), message(pattern), name);
    assert.equal(await h.state(), expected, name);
    assert.equal((await h.store.listRuns("s1"))[0]!.error, (error as Error).message, `${name}: the provider's message is recorded`);
  }
});

test("the caller words what an outcome-unknown failure means for its call", async t => {
  const h = await harness(t);
  await assert.rejects(
    () => h.calls.run(h.call("call-1", () => { throw Object.assign(new Error("bad gateway"), { status: 502 }); }, {
      label: "Research submission",
      uncertainAdvice: reference => `It may have started anyway: ${reference} is being checked.`,
    })),
    message(/^Research submission did not complete: bad gateway\. It may have started anyway: run_[0-9a-f]{16} is being checked\.$/),
  );
});

test("a response that arrived but cannot be used settles as the caller says", async t => {
  for (const state of ["failed", "uncertain"] as const) {
    const h = await harness(t);
    await assert.rejects(
      () => h.calls.run(h.call("call-1", () => ({ id: "", text: "" }), {
        settle: (_response, reference) => { throw new UnusableResponse(state, "response carried nothing", `Nothing usable came back (record ${reference}).`); },
      })),
      message(/^Nothing usable came back \(record run_[0-9a-f]{16}\)\.$/),
    );
    const run = (await h.store.listRuns("s1"))[0]!;
    assert.equal(run.state, state);
    assert.equal(run.error, "response carried nothing");
  }
});

test("a failure message is recorded and shown on one bounded line", async t => {
  const h = await harness(t);
  const body = `{\n  "error": "${"x".repeat(2_000)}"\n}`;
  await assert.rejects(
    () => h.calls.run(h.call("call-1", () => { throw Object.assign(new Error(body), { status: 400 }); }, { settle: settleAsEvidence })),
    (err: Error) => !err.message.includes("\n") && err.message.length < 700,
  );
  const error = (await h.store.listRuns("s1"))[0]!.error ?? "";
  assert.ok(!error.includes("\n") && error.length <= 500, `recorded error is bounded, got ${error.length} chars`);
});

test("a response that cannot be stored leaves the run uncertain and says the request ran", async t => {
  const h = await harness(t);
  await assert.rejects(
    () => h.calls.run(h.call("call-1", () => ({ id: "x", text: "x" }), { settle: () => { throw new TypeError("mapping bug"); } })),
    message(/^Search ran, but its result could not be stored: mapping bug\. Record run_[0-9a-f]{16} is uncertain; repeat the request only if you still need the result\.$/),
  );
  const run = (await h.store.listRuns("s1"))[0]!;
  assert.equal(run.state, "uncertain", "the provider answered and was paid; only the local record is missing");
  assert.match(run.error ?? "", /could not be stored: mapping bug/);
});

test("a call without settle hands the accepted run off in the state its request recorded", async t => {
  const h = await harness(t);
  const outcome = await h.calls.run<{ runId: string }>({
    kind: "task",
    label: "Research submission",
    intent: { kind: "task", input: "goal" },
    processor: "core",
    invocation: { invocationId: "call-1" },
    send: async (_client, { reference }) => {
      await h.store.bindProviderRun({ sessionId: "s1", reference, providerRunId: "trun_1", state: "accepted" });
      return { runId: "trun_1" };
    },
  });
  assert.equal(outcome.replayed, false);
  if (outcome.replayed) return;
  assert.deepEqual(outcome.response, { runId: "trun_1" });
  assert.deepEqual(outcome.evidence, []);
  const run = await h.store.run("s1", outcome.reference);
  assert.equal(run?.state, "accepted", "collection settles it later");
  assert.equal(run?.processor, "core");
  assert.equal(run?.kind, "task");
});
