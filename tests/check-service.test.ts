import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResearchStore } from "../src/store.ts";
import { createCheckService, type CheckClient, type CheckInput } from "../src/check-service.ts";

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

async function harness(t: import("node:test").TestContext) {
  const dir = await mkdtemp(resolve(tmpdir(), "check-service-"));
  const store = new ResearchStore(dir);
  await store.init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const calls: Call[] = [];
  const client: CheckClient = {
    async post(path, options) {
      calls.push({ path, options });
      return response;
    },
  };
  return { calls, service: createCheckService({ store, sessionId: "s1", client: async () => client }) };
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
