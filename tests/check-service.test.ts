import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createAlertDelivery } from "../src/alert-delivery.ts";
import { createRecallService } from "../src/recall.ts";
import { RECEIPT_LIMIT, UNTRUSTED } from "../src/receipt.ts";
import { calendarDate, createCheckService, type CheckClient, type CheckInput } from "../src/check-service.ts";

type Call = { path: string; options: Parameters<CheckClient["post"]>[1] };

const response = {
  mode: "fast",
  decision_id: "dec_secret_1",
  usage: [],
  citations: [
    { url: "https://example.org/a", title: "Alpha", excerpts: ["alpha fact"] },
    { url: "https://example.org/a", title: "Alpha again", excerpts: ["dup"] },
    { url: "https://news.example.com/b", title: null, excerpts: [] },
  ],
  answers: {
    rain: { type: "noul", noul: 0.93 },
    pick: { type: "choice", choice: "left", probabilities: { left: 0.81, right: 0.19 }, confidence: 0.7 },
    level: { type: "score", score: 2.4, legend: { "0": "none", "1": "low", "2": "medium", "3": "high" }, probabilities: {}, confidence: null },
    nope: { type: "refusal" },
  },
};

const input: CheckInput = {
  state: "The bridge is closed",
  questions: {
    rain: { type: "noul", instructions: "Will it rain?" },
    pick: { type: "choice", instructions: "Which way?", criteria: { left: "go left", right: "go right" } },
    level: { type: "score", instructions: "How bad?", criteria: ["none", "low", "medium", "high"] },
    nope: { type: "noul", instructions: "Something refused" },
  },
};

async function harness(t: import("node:test").TestContext, respond: () => unknown = () => response) {
  const dir = await mkdtemp(resolve(tmpdir(), "check-service-"));
  const store = new ResearchStore(dir);
  await store.init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const calls: Call[] = [];
  const client: CheckClient = {
    async post(path, options) {
      calls.push({ path, options });
      return respond();
    },
  };
  return { store, calls, service: createCheckService({ store, sessionId: "s1", client: async () => client }) };
}

test("check sends a fast decision request and reports every verdict", async t => {
  const { calls, service } = await harness(t);
  const receipt = await service.check(input, { invocationId: "inv-1" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "/v1/decisions");
  const body = calls[0]!.options!.body as { mode: string; advanced_settings: { include_excerpts: boolean } };
  assert.equal(body.mode, "fast");
  assert.equal(body.advanced_settings.include_excerpts, true);
  assert.equal(calls[0]!.options!.maxRetries, 0);

  assert.match(receipt.text, /rain \(noul\): 0\.93 probability true/);
  assert.match(receipt.text, /pick \(choice\): left \(p 0\.81, confidence 0\.70\)/);
  assert.match(receipt.text, /level \(score\): 2\.40 on 0-3, nearest level 2 "medium"/);
  assert.match(receipt.text, /nope \(refusal\): the provider declined to answer/);
  assert.doesNotMatch(receipt.text, /dec_secret_1/);
  assert.equal(receipt.details.sources, 2);
  assert.equal(receipt.details.refusals, 1);
});

test("check replays the same invocation without sending again", async t => {
  const { calls, service } = await harness(t);
  await service.check(input, { invocationId: "inv-1" });
  const again = await service.check(input, { invocationId: "inv-1" });
  assert.equal(calls.length, 1);
  assert.match(again.text, /not sent again/);
});

const invocation = { invocationId: "test-check" };
const noul = input.questions.rain!;

for (const [name, question, answers, expected] of [
  ["noul", noul, { is_x: response.answers.rain }, /is_x \(noul\): 0\.93 probability true/],
  ["choice", input.questions.pick!, { is_x: { ...response.answers.pick, confidence: null } }, /is_x \(choice\): left \(p 0\.81\)$/m],
  ["score", input.questions.level!, { is_x: response.answers.level }, /2\.40 on 0-3, nearest level 2 "medium"/],
  ["refusal", noul, { is_x: response.answers.nope }, /is_x \(refusal\)/],
  ["missing answer", noul, { unasked: response.answers.rain }, /is_x: no answer returned/],
] as const) {
  test(`single question: ${name}`, async t => {
    const { service } = await harness(t, () => ({ answers, citations: [] }));
    const receipt = await service.check({ state: input.state, questions: { is_x: question } }, invocation);
    assert.match(receipt.text, expected);
    assert.doesNotMatch(JSON.stringify(receipt), /unasked/);
    assert.equal(receipt.details.refusals, name === "refusal" ? 1 : 0);
  });
}

test("recall lists verdicts and one readable excerpt per unique source", async t => {
  const { service, store } = await harness(t, () => ({ ...response, citations: [
    { ...response.citations[0], excerpts: ["first fact", "second fact"] },
    response.citations[1],
    { ...response.citations[2], title: "Title only" },
  ] }));
  const receipt = await service.check(input, invocation);
  assert.doesNotMatch(JSON.stringify(receipt), /dec_secret_1/);
  const reference = String(receipt.details.reference);
  const run = await store.run("s1", reference);
  assert.equal(run?.state, "completed");
  assert.match(run.summary ?? "", /4 questions.*2 sources/);
  const alerts = createAlertDelivery({ store, sessionId: "s1", deliver: () => undefined });
  const recall = createRecallService({ store, sessionId: "s1", alerts });
  const listing = await recall.recall({ reference });
  assert.equal(listing.details.hits, 3);
  assert.match(listing.text, /\(structured,[^\n]+Check verdicts/);
  for (const [url, body] of [["https://example.org/a", "first fact\n\nsecond fact"], ["https://news.example.com/b", "Title only"]] as const) {
    const line = listing.text.split("\n").find(line => line.startsWith("- ") && line.includes("(excerpt,") && line.includes(url));
    assert.ok(line, `missing excerpt for ${url}`);
    const read = await recall.recall({ handle: line.split(" ")[1]! });
    assert.ok(read.text.includes(`\n\n${body}\nEnd of stored text.`));
  }
});

test("calendar dates must be real and zero-padded", () => {
  assert.equal(calendarDate("2024-02-29"), "2024-02-29");
  for (const invalid of ["2025-02-31", "2025-13-01", "2025-2-1"]) {
    assert.throws(() => calendarDate(invalid), /after_date/);
  }
});

test("validates search settings before sending and normalizes location", async t => {
  const { service, calls } = await harness(t);
  await assert.rejects(service.check({ ...input, after_date: "2025-02-31" }, invocation), /after_date/);
  await assert.rejects(service.check({ ...input, location: "USA" }, invocation), /location/);
  assert.equal(calls.length, 0);
  await service.check({ ...input, after_date: "2024-02-29", location: "US" }, invocation);
  assert.deepEqual(calls[0]?.options?.body?.advanced_settings, {
    after_date: "2024-02-29", location: "us", include_excerpts: true,
  });
});

function manyQuestions(n: number) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`question_number_${i}`, noul]));
}

test("invalid questions and state are neither sent nor recorded", async t => {
  const { service, calls, store } = await harness(t);
  const invalid: [unknown, RegExp][] = [
    [{}, /1-100/],
    [{ "a b": noul }, /question key/],
    [manyQuestions(101), /1-100/],
    [{ q: { ...input.questions.pick, criteria: { left: "go left" } } }, /choice criteria/],
    [{ q: { ...input.questions.level, criteria: ["zero"] } }, /score criteria/],
    [{ q: { ...input.questions.level, criteria: Array(11).fill("level") } }, /score criteria/],
    [{ q: { type: "noul" } }, /instructions/],
    [{ q: { ...noul, type: "other" } }, /type/],
    [{ q: { ...noul, extra: true } }, /unknown field/],
    [{ q: { ...noul, criteria: { true: "yes" } } }, /noul criteria/],
  ];
  for (const [questions, reason] of invalid) {
    await assert.rejects(service.check({ ...input, questions: questions as CheckInput["questions"] }, invocation), reason);
  }
  for (const state of ["", "  ", {}, null]) {
    await assert.rejects(service.check({ ...input, state }, invocation), /state/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await store.listRuns("s1"), []);
});

for (const [status, state] of [[400, "failed"], [500, "uncertain"]] as const) {
  test(`provider ${status} leaves the run ${state}`, async t => {
    const { service, store, calls } = await harness(t, () => {
      throw Object.assign(new Error("bad request"), { status });
    });
    await assert.rejects(service.check(input, invocation), /Check did not complete/);
    assert.deepEqual((await store.listRuns("s1")).map(run => run.state), [state]);
    if (status === 400) {
      const replay = await service.check(input, invocation);
      assert.match(replay.text, /not sent again/);
    }
    assert.equal(calls.length, 1);
  });
}

test("each answer type renders on its own", async t => {
  const questions = {
    choice: input.questions.pick!,
    score: input.questions.level!,
    refusal: noul,
    missing: noul,
  };
  const answers = {
    choice: { ...response.answers.pick, confidence: null },
    score: response.answers.level,
    refusal: response.answers.nope,
    extra_unasked: response.answers.rain,
  };
  const { service } = await harness(t, () => ({ answers, citations: [] }));
  const receipt = await service.check({ state: input.state, questions }, invocation);
  const choiceLine = receipt.text.split("\n").find(line => line.startsWith("choice (choice):"));
  assert.equal(choiceLine, "choice (choice): left (p 0.81)");
  assert.doesNotMatch(choiceLine!, /confidence/);
  assert.match(receipt.text, /score \(score\): 2\.40 on 0-3, nearest level 2 "medium"/);
  assert.match(receipt.text, /nearest level 2 "medium"/);
  assert.match(receipt.text, /refusal \(refusal\)/);
  assert.equal(receipt.details.refusals, 1);
  assert.match(receipt.text, /missing: no answer returned/);
  assert.doesNotMatch(receipt.text, /extra_unasked/);
});

test("a response without answers leaves the run uncertain", async t => {
  const { service, store } = await harness(t, () => ({}));
  await assert.rejects(service.check(input, invocation), /unusable/);
  assert.deepEqual((await store.listRuns("s1")).map(run => run.state), ["uncertain"]);
});

test("a large receipt preserves the recall instruction and untrusted warning", async t => {
  const questions = manyQuestions(100);
  const answers = Object.fromEntries(Object.keys(questions).map(key => [key, response.answers.rain]));
  const citations = Array.from({ length: 30 }, (_, i) => ({ url: `https://example.org/${i}` }));
  const { service } = await harness(t, () => ({ answers, citations }));
  const receipt = await service.check({ ...input, questions }, invocation);
  assert.ok(receipt.text.length <= RECEIPT_LIMIT);
  assert.ok(receipt.text.includes(UNTRUSTED));
  assert.match(receipt.text, /web_recall \{ reference/);
});
