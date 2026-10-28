import assert from "node:assert/strict";
import test from "node:test";
import { formatSpend, statusTotals, WebtasksStatus, type RunSummary } from "../src/status.ts";
import { setup } from "./helpers/test-host.ts";

const ICON = { web: "\u{F002}", answer: "\u{F27A}", research: "\u{F02D}", spend: "\u{F0D6}" };
const plain = (text: string | undefined) => (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("totals count sources per lane and price completed runs at list prices", () => {
  const runs: RunSummary[] = [
    { kind: "search", state: "completed", intent: { mode: "basic" }, sources: 12 },
    { kind: "search", state: "completed", intent: { mode: "fast" }, sources: 4 },
    { kind: "extract", state: "completed", intent: { urls: ["a", "b", "c"] }, sources: 2 },
    { kind: "answer", state: "completed", intent: { effort: "medium" }, sources: 3 },
    { kind: "task", state: "completed", processor: "pro", intent: {}, sources: 7 },
    { kind: "task", state: "pending", processor: "core", intent: {}, sources: 1 },
    { kind: "search", state: "failed", intent: { mode: "advanced" }, sources: 0 },
  ];
  const totals = statusTotals(runs);
  assert.deepEqual(totals.counts, { web: 18, answer: 1, research: 7 }, "only completed runs count; interim research sources wait for completion");
  // basic 5000 + 2 extra results 2000, fast 1000, extract 3 URLs 3000, answer medium 50000, task pro 100000.
  assert.equal(totals.microdollars, 161_000);
  assert.equal(totals.researchInProgress, 1);
  assert.equal(totals.unpriced, false);
  assert.equal(statusTotals([{ kind: "answer", state: "uncertain", intent: { effort: "high" }, sources: 0 }]).unpriced, true, "an unknown outcome may have been billed");
});

test("spend fits in a few characters", () => {
  assert.equal(formatSpend(0), "0");
  assert.equal(formatSpend(161_000), "0.16");
  assert.equal(formatSpend(12_400_000), "12");
  assert.equal(formatSpend(1_234_000_000), "1.23K");
});

test("the footer shows each lane's icon and count, and spins while a lane works", async () => {
  const writes: (string | undefined)[] = [];
  let runs: RunSummary[] = [];
  const status = new WebtasksStatus(text => writes.push(text), async () => runs);
  assert.equal(plain(writes.at(-1)), `${ICON.web} 0  ${ICON.answer} 0  ${ICON.research} 0  ${ICON.spend} 0`);
  assert.match(writes.at(-1)!, /\x1b\[38;5;39m/, "web keeps its blue");

  const end = status.begin("web");
  assert.match(plain(writes.at(-1)), new RegExp(`^${ICON.web} 0⠋`), "a busy lane shows a spinner frame");
  runs = [{ kind: "search", state: "completed", intent: { mode: "basic" }, sources: 3 }];
  end();
  await status.refresh();
  assert.equal(plain(writes.at(-1)), `${ICON.web} 3  ${ICON.answer} 0  ${ICON.research} 0  ${ICON.spend} 0.01`);

  runs.push({ kind: "task", state: "pending", processor: "core", intent: {}, sources: 0 });
  await status.refresh();
  assert.match(plain(writes.at(-1)), new RegExp(`${ICON.research} 0⠋`), "research spins while a run is in progress");

  status.close();
  assert.equal(writes.at(-1), undefined, "closing clears the footer");
});

test("a web_search call updates the webtasks footer status through Pi's loader", async t => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const h = await setup(t, call => call.path === "/v1/search"
    ? json({ search_id: "s1", session_id: "ps1", results: [{ url: "https://example.org/a", title: "A", excerpts: ["alpha"] }, { url: "https://example.org/b", title: "B", excerpts: ["beta"] }] })
    : json({}));
  await h.start();
  await h.call("web_search", { objective: "What does alpha say about beta?", search_queries: ["alpha beta"] });
  const ours = () => h.statusWrites.filter((w: { key: string }) => w.key === "webtasks");
  for (let i = 0; i < 50 && !plain(ours().at(-1)?.text).startsWith(`${ICON.web} 2`); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(ours().some((w: { text?: string }) => /⠋/.test(plain(w.text))), "the web lane spun during the call");
  assert.equal(plain(ours().at(-1)?.text), `${ICON.web} 2  ${ICON.answer} 0  ${ICON.research} 0  ${ICON.spend} 0.01`);
  await h.stop();
  assert.equal(ours().at(-1)?.text, undefined, "shutdown clears the footer");
});
