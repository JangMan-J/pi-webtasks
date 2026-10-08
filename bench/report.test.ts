// bench/report.test.ts — offline acceptance checks for the stats/report and
// scoring-preparation pipeline. All cases are small and hand-computed, with
// explicit zero, incomplete, and censored coverage. No paid endpoint is ever
// contacted; there is no network in this file at all.

import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  type Arm,
  type RunRecord,
  type RunScore,
  type ScoredPair,
  analyzeEndpoint,
  bootstrapPairedInterval,
  buildReport,
  conservativeScore,
  contextTokens,
  costTable,
  decideClaim,
  exactSignTest,
  isSuccessful,
  leaveOneFamilyOut,
  outcomeInventory,
  pairRuns,
  restrictedMeanTime,
  selectScoredPairs,
  tokenEfficiency,
  triggerTimings,
} from "./report.ts";
import {
  applyFinalAdjudications,
  buildAdjudicationQueue,
  buildRaterInput,
  compareScores,
  missingScores,
  neutralizeEvents,
  normalizeGold,
  overlayFinalScore,
  scoresByRun,
  validateScore,
  type FinalAdjudicationRecord,
} from "./score.ts";

let seq = 0;
function mkRun(over: Partial<RunRecord> & { pairId: string; arm: Arm }): RunRecord {
  return {
    runId: `run-${++seq}`,
    caseId: over.pairId,
    phase: "primary",
    status: "completed",
    elapsedMs: 1000,
    deadlineMs: 600_000,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    events: [{ id: "e1", type: "message" }],
    answer: "answer",
    sourceFamily: "fam",
    ...over,
  };
}

// Default score: quality 3, retrieval 2. Valid under the per-criterion
// citation rules: one awarded entry (support point) and one penalty entry
// (the unawarded fourth quality point).
function mkScore(runId: string, over: Partial<RunScore> = {}): RunScore {
  return {
    runId,
    retrieval: 2,
    quality: 3,
    criticalViolation: false,
    materialWrong: false,
    fabricatedCitation: false,
    evidenceEventIds: ["e1"],
    supportedClaims: 1,
    notes: "ok",
    metadata: {
      evidence: [
        { criterion: "quality.support", outcome: "awarded", eventIds: ["e1"] },
        { criterion: "quality.uncertainty", outcome: "penalty", eventIds: ["e1"] },
      ],
    },
    ...over,
  };
}

function scoreMap(scores: RunScore[]): Map<string, RunScore> {
  return new Map(scores.map((s) => [s.runId, s]));
}

function mkScoredPair(
  pairId: string,
  e: { retrieval: number; quality: number },
  c: { retrieval: number; quality: number },
  sourceFamily = "fam",
): ScoredPair & { eRun: RunRecord; cRun: RunRecord } {
  const eRun = mkRun({ pairId, arm: "E", caseId: pairId, sourceFamily });
  const cRun = mkRun({ pairId, arm: "C", caseId: pairId, sourceFamily });
  return {
    pair: pairRuns([eRun, cRun])[0],
    eRun,
    cRun,
    eScore: mkScore(eRun.runId, e),
    cScore: mkScore(cRun.runId, c),
  };
}

/** n pairs with constant per-pair retrieval/quality scores. */
function mkScoredPairs(
  n: number,
  e: { retrieval: number; quality: number },
  c: { retrieval: number; quality: number },
): { runs: RunRecord[]; scores: RunScore[] } {
  const runs: RunRecord[] = [];
  const scores: RunScore[] = [];
  for (let i = 0; i < n; i++) {
    const p = mkScoredPair(`p${i}`, e, c);
    runs.push(p.eRun, p.cRun);
    scores.push(p.eScore, p.cScore);
  }
  return { runs, scores };
}

const strataFor = (runs: RunRecord[]) => Object.fromEntries(runs.map((r) => [r.caseId, "web" as const]));

// ---------------------------------------------------------------------------
// Bootstrap interval
// ---------------------------------------------------------------------------

test("bootstrap: constant deltas give a point interval at the delta", () => {
  const { meanDelta, ci } = bootstrapPairedInterval([1, 1, 1, 1]);
  assert.equal(meanDelta, 1);
  assert.equal(ci.lo, 1);
  assert.equal(ci.hi, 1);
  assert.equal(ci.resamples, BOOTSTRAP_RESAMPLES);
  assert.equal(ci.seed, BOOTSTRAP_SEED);
  assert.equal(ci.level, 0.95);
});

test("bootstrap: deterministic under the fixed seed and bounded by the data", () => {
  const deltas = [0, 2, 1, 0];
  const a = bootstrapPairedInterval(deltas);
  const b = bootstrapPairedInterval(deltas);
  assert.deepEqual(a, b); // fixed seed 42017 reproduces exactly
  assert.equal(a.meanDelta, 0.75); // hand-computed: (0+2+1+0)/4
  assert.ok(a.ci.lo >= 0 && a.ci.hi <= 2); // resample means stay within [min,max]
  assert.ok(a.ci.lo <= a.meanDelta && a.meanDelta <= a.ci.hi);
  const other = bootstrapPairedInterval(deltas, { seed: 1 });
  assert.notDeepEqual(other.ci, a.ci); // a different seed moves the interval
});

test("bootstrap: all-positive deltas exclude zero; empty input throws", () => {
  const { ci } = bootstrapPairedInterval([2, 1, 2, 1, 2]);
  assert.ok(ci.lo > 0);
  assert.throws(() => bootstrapPairedInterval([]));
});

// ---------------------------------------------------------------------------
// Exact sign test
// ---------------------------------------------------------------------------

test("sign test: hand-computed exact two-sided p-values", () => {
  // 5 positives out of 5: p = 2 * (1/2)^5 = 0.0625
  assert.deepEqual(exactSignTest([1, 2, 1, 1, 2]), { n: 5, positives: 5, negatives: 0, p: 0.0625 });
  // 4 positives out of 4 nonzero (one tie excluded): p = 2 * (1/2)^4 = 0.125
  assert.deepEqual(exactSignTest([1, 1, 0, 1, 1]), { n: 4, positives: 4, negatives: 0, p: 0.125 });
  // balanced: p = 1
  assert.equal(exactSignTest([1, -1]).p, 1);
  // no informative pairs: p = 1, n = 0
  assert.deepEqual(exactSignTest([0, 0]), { n: 0, positives: 0, negatives: 0, p: 1 });
});

// ---------------------------------------------------------------------------
// Success classification and conservative failure scores
// ---------------------------------------------------------------------------

test("success: completed status, quality >= 3, no material-wrong/critical/fabricated flags", () => {
  const run = mkRun({ pairId: "p", arm: "E" });
  assert.equal(isSuccessful(run, mkScore(run.runId, { quality: 3 })), true);
  assert.equal(isSuccessful(run, mkScore(run.runId, { quality: 2 })), false);
  assert.equal(isSuccessful(run, mkScore(run.runId, { quality: 4, materialWrong: true })), false);
  // a fabricated material citation fails the run regardless of points
  assert.equal(isSuccessful(run, mkScore(run.runId, { quality: 4, fabricatedCitation: true })), false);
  assert.equal(isSuccessful(run, mkScore(run.runId, { quality: 4, criticalViolation: true })), false);
  assert.equal(isSuccessful(mkRun({ pairId: "p2", arm: "E", status: "timeout" }), mkScore("x", { quality: 4 })), false);
  assert.equal(isSuccessful(run, undefined), false); // missing score is not a success
});

test("conservative failure scores zero the numbers but preserve violation flags", () => {
  const timedOut = mkRun({ pairId: "p", arm: "C", status: "timeout" });
  const scored = mkScore(timedOut.runId, { retrieval: 2, quality: 4, supportedClaims: 3, materialWrong: true });
  const cons = conservativeScore(timedOut, scored);
  assert.equal(cons.retrieval, 0);
  assert.equal(cons.quality, 0);
  assert.equal(cons.supportedClaims, 0);
  assert.equal(cons.materialWrong, true); // penalties are kept, not erased
  const missing = conservativeScore(timedOut, undefined);
  assert.equal(missing.quality, 0);
  assert.match(missing.notes, /missing score/);
  // completed runs keep their actual scores
  const ok = mkRun({ pairId: "p2", arm: "E" });
  const okScore = mkScore(ok.runId, { quality: 4 });
  assert.equal(conservativeScore(ok, okScore), okScore);
});

// ---------------------------------------------------------------------------
// Paired endpoint analysis
// ---------------------------------------------------------------------------

test("analyzeEndpoint: raw deltas, mean, and sign test over pairs", () => {
  const scored = [
    mkScoredPair("q0", { retrieval: 2, quality: 3 }, { retrieval: 1, quality: 3 }),
    mkScoredPair("q1", { retrieval: 2, quality: 3 }, { retrieval: 0, quality: 3 }),
    mkScoredPair("q2", { retrieval: 1, quality: 3 }, { retrieval: 1, quality: 3 }),
    mkScoredPair("q3", { retrieval: 0, quality: 3 }, { retrieval: 0, quality: 3 }),
  ];
  const r = analyzeEndpoint(scored, (s) => s.retrieval);
  assert.deepEqual(r.deltas, [1, 2, 0, 0]);
  assert.equal(r.meanDelta, 0.75); // hand-computed
  assert.equal(r.nPairs, 4);
  assert.equal(r.signTest.n, 2); // two ties excluded
  assert.equal(r.signTest.positives, 2);
  assert.equal(r.signTest.p, 0.5); // 2/2 positives: 2 * (1/2)^2
});

// ---------------------------------------------------------------------------
// Leave-one-source-family-out
// ---------------------------------------------------------------------------

test("leave-one-family-out: per-family exclusion with hand-computed means", () => {
  const scored = [
    mkScoredPair("f1", { retrieval: 2, quality: 3 }, { retrieval: 0, quality: 3 }, "alpha"),
    mkScoredPair("f2", { retrieval: 2, quality: 3 }, { retrieval: 0, quality: 3 }, "alpha"),
    mkScoredPair("f3", { retrieval: 1, quality: 3 }, { retrieval: 0, quality: 3 }, "beta"),
  ];
  const lofo = leaveOneFamilyOut(scored, (s) => s.retrieval);
  assert.equal(lofo.length, 2);
  const dropAlpha = lofo.find((r) => r.droppedFamily === "alpha")!;
  assert.equal(dropAlpha.nPairs, 1);
  assert.equal(dropAlpha.meanDelta, 1);
  const dropBeta = lofo.find((r) => r.droppedFamily === "beta")!;
  assert.equal(dropBeta.nPairs, 2);
  assert.equal(dropBeta.meanDelta, 2); // constant deltas: interval collapses to [2,2]
  assert.equal(dropBeta.ci.lo, 2);
  assert.equal(dropBeta.favorable, true);
});

test("family-specific advantage is labeled in the claim, not generally superior", () => {
  // fam-a carries the whole effect; fam-b pairs are flat.
  const runs: RunRecord[] = [];
  const scores: RunScore[] = [];
  for (let i = 0; i < 8; i++) {
    const fam = i < 4 ? "fam-a" : "fam-b";
    const p = mkScoredPair(
      `p${i}`,
      { retrieval: fam === "fam-a" ? 2 : 1, quality: 3 },
      { retrieval: 1, quality: 3 },
      fam,
    );
    runs.push(p.eRun, p.cRun);
    scores.push(p.eScore, p.cScore);
  }
  const report = buildReport({ runs, scores, caseStrata: strataFor(runs) });
  assert.equal(report.primary.meanDelta, 0.5);
  assert.ok(report.primary.ci.lo > 0); // favorable on the full mix
  assert.equal(report.familySpecific, true);
  assert.equal(report.claim.decision, "mixed");
  assert.ok(report.claim.reasons.some((r) => r.includes("family-specific")));
  assert.ok(report.notes.some((n) => n.includes("family-specific")));
});

// ---------------------------------------------------------------------------
// Restricted mean time with censoring
// ---------------------------------------------------------------------------

test("restricted mean time: unsuccessful runs are censored at the common deadline", () => {
  const eRun = mkRun({ pairId: "p", arm: "E", elapsedMs: 100_000, deadlineMs: 600_000 });
  const cRun = mkRun({ pairId: "p", arm: "C", status: "timeout", elapsedMs: 600_000, deadlineMs: 600_000 });
  const scores = scoreMap([mkScore(eRun.runId), mkScore(cRun.runId)]);
  const r = restrictedMeanTime(pairRuns([eRun, cRun]), scores);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].tau, 600_000);
  assert.equal(r.rows[0].eRestrictedMs, 100_000); // successful: actual time
  assert.equal(r.rows[0].cRestrictedMs, 600_000); // censored at tau, not zero-time
  assert.equal(r.rows[0].cCensored, true);
  assert.equal(r.perArmMeanMs.E, 100_000);
  assert.equal(r.perArmMeanMs.C, 600_000);
  assert.equal(r.meanDeltaMs, -500_000); // single pair: interval collapses
  assert.equal(r.ci.lo, -500_000);
  assert.equal(r.descriptiveSuccessfulMedianMs.E, 100_000);
  assert.equal(r.descriptiveSuccessfulMedianMs.C, null); // no C successes
});

test("restricted mean time: elapsed past the deadline is capped; timeout censors", () => {
  const eRun = mkRun({ pairId: "p", arm: "E", elapsedMs: 700_000, deadlineMs: 600_000 });
  const cRun = mkRun({ pairId: "p", arm: "C", elapsedMs: 100_000, deadlineMs: 600_000 });
  const scores = scoreMap([mkScore(eRun.runId), mkScore(cRun.runId)]);
  const r = restrictedMeanTime(pairRuns([eRun, cRun]), scores);
  assert.equal(r.rows[0].eRestrictedMs, 600_000);
  // a timed-out run is unsuccessful even with a perfect-looking score
  const cTimeout = mkRun({ pairId: "q", arm: "C", status: "timeout", elapsedMs: 50_000, deadlineMs: 600_000 });
  const eOk = mkRun({ pairId: "q", arm: "E", elapsedMs: 50_000, deadlineMs: 600_000 });
  const scores2 = scoreMap([mkScore(eOk.runId, { quality: 4 }), mkScore(cTimeout.runId, { quality: 4 })]);
  const r2 = restrictedMeanTime(pairRuns([eOk, cTimeout]), scores2);
  assert.equal(r2.rows[0].cRestrictedMs, 600_000);
  assert.equal(r2.rows[0].cCensored, true);
});

// ---------------------------------------------------------------------------
// Token efficiency, including zeros, failed runs, and unscored runs
// ---------------------------------------------------------------------------

test("token efficiency: hand-computed ratios, failed runs included, zero tokens are N/A", () => {
  const e1 = mkRun({ pairId: "p1", arm: "E", usage: { input: 6000, cacheRead: 2000, cacheWrite: 0, output: 2000 } });
  const e2 = mkRun({ pairId: "p2", arm: "E", status: "failed", usage: { input: 10_000, cacheRead: 0, cacheWrite: 0, output: 0 } });
  const c1 = mkRun({ pairId: "p1", arm: "C" });
  const c2 = mkRun({ pairId: "p2", arm: "C" });
  // c2 deliberately left unscored: explicit, counted, never a silent zero
  const scores = scoreMap([
    mkScore(e1.runId, { quality: 3, supportedClaims: 2 }),
    mkScore(e2.runId, { quality: 0, supportedClaims: 0 }),
    mkScore(c1.runId, { quality: 4, supportedClaims: 4 }),
  ]);
  const eff = tokenEfficiency([e1, e2, c1, c2], scores, { p1: "web", p2: "no_web" });
  // E: quality 3+0 over 10k+10k tokens -> 3*10000/20000 = 1.5; claims 2 -> 1.0
  assert.equal(eff.overall.E.contextTokens, 20_000); // failed run's tokens count
  assert.equal(eff.overall.E.qualityPointsPer10kTokens, 1.5);
  assert.equal(eff.overall.E.supportedClaimsPer10kTokens, 1);
  // C: zero context tokens -> N/A, never an artificial denominator
  assert.equal(eff.overall.C.contextTokens, 0);
  assert.equal(eff.overall.C.qualityPointsPer10kTokens, null);
  assert.equal(eff.overall.C.supportedClaimsPer10kTokens, null);
  assert.equal(eff.overall.C.unscoredRuns, 1);
  assert.equal(eff.overall.C.sumQuality, 4); // only the scored run contributes
  // strata split
  assert.equal(eff.byStratum.web!.E.contextTokens, 10_000);
  assert.equal(eff.byStratum.no_web!.E.contextTokens, 10_000);
  assert.throws(() => tokenEfficiency([e1], scores, {})); // missing stratum entry
});

test("context tokens sum the four disjoint fields once, excluding reasoning", () => {
  assert.equal(contextTokens({ input: 1, cacheRead: 2, cacheWrite: 4, output: 8, reasoning: 16 }), 15);
});

// ---------------------------------------------------------------------------
// Cost table: service liability distinct from model token costs
// ---------------------------------------------------------------------------

test("cost table: liability, claims-per-dollar N/A at zero spend, unknown model cost", () => {
  const e1 = mkRun({
    pairId: "p1",
    arm: "E",
    usage: { input: 1_000_000, cacheRead: 500_000, cacheWrite: 0, output: 250_000 },
    parallelLiabilityMicro: 250_000, // $0.25
  });
  const e2 = mkRun({ pairId: "p2", arm: "E" }); // no liability field yet (gateway API pending)
  const c1 = mkRun({ pairId: "p1", arm: "C", parallelLiabilityMicro: 0 });
  const scores = scoreMap([
    mkScore(e1.runId, { supportedClaims: 2 }),
    mkScore(e2.runId, { supportedClaims: 1 }),
    mkScore(c1.runId, { supportedClaims: 5 }),
  ]);
  const costs = costTable([e1, e2, c1], scores);
  assert.equal(costs.E.parallelLiabilityMicro, 250_000);
  assert.equal(costs.E.parallelLiabilityUsd, 0.25);
  assert.equal(costs.E.supportedClaimsTotal, 3);
  assert.equal(costs.E.claimsPerParallelDollar, null); // attribution and one run's liability are unknown
  assert.equal(costs.E.runsWithoutAttribution, 2);
  const attributed = costTable([e1], scoreMap([mkScore(e1.runId, {supportedClaims: 2, metadata: {parallelSupportedClaims: 1}})]));
  assert.equal(attributed.E.claimsPerParallelDollar, 4); // only the one Parallel-supported claim / $0.25
  assert.equal(costs.E.modelCostUsd, null); // no prices: unknown, not zero
  assert.equal(costs.E.runsWithoutLiability, 1); // e2: unknown, not verified zero
  assert.equal(costs.C.parallelLiabilityUsd, 0);
  assert.equal(costs.C.runsWithoutLiability, 0);
  assert.equal(costs.C.claimsPerParallelDollar, null); // zero-dollar stratum: N/A
  assert.ok(costs.notes.some((n) => n.includes("runsWithoutLiability")));
  const priced = costTable([e1, e2, c1], scores, {
    uncachedInputPerM: 2,
    cacheReadPerM: 0.2,
    cacheWritePerM: 2,
    outputPerM: 8,
  });
  // E model estimate: 1M*$2 + 0.5M*$0.2 + 0.25M*$8 = $2 + $0.1 + $2 = $4.10
  assert.equal(priced.E.modelCostUsd, 4.1);
  assert.ok(priced.notes.some((n) => n.includes("reserved-liability")));
});

// ---------------------------------------------------------------------------
// Outcome inventory: attempted, incomplete, censored, unattempted
// ---------------------------------------------------------------------------

test("outcome inventory keeps failures and synthesizes unattempted placeholders", () => {
  const ok = mkRun({ pairId: "p1", arm: "E" });
  const timedOut = mkRun({ pairId: "p1", arm: "C", status: "timeout" });
  const limited = mkRun({ pairId: "p2", arm: "E", status: "limit" });
  const fault = mkRun({ pairId: "p2", arm: "C", status: "harness_error" });
  const scores = scoreMap([mkScore(ok.runId), mkScore(timedOut.runId)]);
  const inv = outcomeInventory([ok, timedOut, limited, fault], scores, ["p1", "p2", "p3"]);
  assert.equal(inv.rows.length, 4 + 2); // p3 gets two unattempted placeholders
  assert.equal(inv.countsByStatus.completed, 1);
  assert.equal(inv.countsByStatus.timeout, 1);
  assert.equal(inv.countsByStatus.limit, 1);
  assert.equal(inv.countsByStatus.harness_error, 1);
  assert.equal(inv.countsByStatus.unattempted, 2);
  assert.equal(inv.truncated, true);
  const placeholder = inv.rows.find((r) => r.pairId === "p3" && r.arm === "E")!;
  assert.equal(placeholder.runId, null);
  assert.equal(placeholder.successful, false);
  const faultRow = inv.rows.find((r) => r.status === "harness_error")!;
  assert.match(faultRow.note!, /retained/); // original attempt and charges retained
  // an unscored run is explicitly visible as missing its score
  const limitedRow = inv.rows.find((r) => r.status === "limit")!;
  assert.equal(limitedRow.scored, false);
  // no expectedPairs -> no truncation claim
  assert.equal(outcomeInventory([ok, timedOut], scores).truncated, false);
});

// ---------------------------------------------------------------------------
// Pair selection: missing arms and missing scores never vanish silently
// ---------------------------------------------------------------------------

test("selectScoredPairs excludes incomplete pairs with stated reasons", () => {
  const eRun = mkRun({ pairId: "p1", arm: "E" });
  const cRun = mkRun({ pairId: "p1", arm: "C" });
  const lonely = mkRun({ pairId: "p2", arm: "E" });
  const unscored = mkRun({ pairId: "p3", arm: "E" });
  const unscoredC = mkRun({ pairId: "p3", arm: "C" });
  const pairs = pairRuns([eRun, cRun, lonely, unscored, unscoredC]);
  const sel = selectScoredPairs(pairs, scoreMap([mkScore(eRun.runId), mkScore(cRun.runId), mkScore(unscoredC.runId)]), {
    conservative: false,
  });
  assert.equal(sel.scored.length, 1);
  assert.equal(sel.excluded.length, 2);
  assert.match(sel.excluded.find((e) => e.pairId === "p2")!.reason, /missing arm C/);
  assert.match(sel.excluded.find((e) => e.pairId === "p3")!.reason, /missing score/);
  // conservative selection keeps the unscored pair with explicit failure scores
  const cons = selectScoredPairs(pairs, scoreMap([mkScore(eRun.runId), mkScore(cRun.runId)]), { conservative: true });
  assert.equal(cons.scored.length, 2); // p1 + p3; p2 still lacks an arm
  const p3 = cons.scored.find((p) => p.pair.pairId === "p3")!;
  assert.equal(p3.eScore.quality, 0);
  assert.equal(p3.eScore.retrieval, 0);
});

// ---------------------------------------------------------------------------
// Claim decision (preregistered thresholds)
// ---------------------------------------------------------------------------

test("buildReport: full superiority claim when every preregistered gate passes", () => {
  const { runs, scores } = mkScoredPairs(12, { retrieval: 2, quality: 3 }, { retrieval: 1, quality: 3 });
  const report = buildReport({
    runs,
    scores,
    caseStrata: strataFor(runs),
    expectedPairs: runs.filter((r) => r.arm === "E").map((r) => r.pairId),
    scoringSummary: { agreementRate: 1, adjudicationCount: 0, missingScoreCount: 0 },
  });
  assert.equal(report.claim.decision, "superior");
  assert.equal(report.primary.meanDelta, 1);
  assert.equal(report.primary.ci.lo, 1); // constant deltas exclude zero
  assert.equal(report.quality.qualityDegradationRuledOut, true); // quality delta 0 > -0.25
  assert.equal(report.violations.eCritical, 0);
  assert.ok(Math.abs(report.primary.signTest.p - 2 * 0.5 ** 12) < 1e-12); // exact: 12/12 positives
  assert.equal(report.outcomeInventory.truncated, false);
  assert.ok(report.claim.reasons.some((r) => r.includes("source-family"))); // family scope caveat in the claim
  assert.ok(report.notes.some((n) => n.includes("fixed mixture of task blocks")));
});

test("buildReport: an extension-arm critical violation blocks superiority (gate)", () => {
  const { runs, scores } = mkScoredPairs(12, { retrieval: 2, quality: 3 }, { retrieval: 1, quality: 3 });
  scores[0] = { ...scores[0], criticalViolation: true }; // an E-arm run
  const report = buildReport({ runs, scores, caseStrata: strataFor(runs) });
  assert.equal(report.claim.decision, "mixed");
  assert.equal(report.violations.eCritical, 1);
  assert.equal(report.violations.cCritical, 0);
  assert.ok(report.claim.reasons.some((r) => r.includes("critical")));
});

test("buildReport: quality degradation beyond the margin yields mixed, not superior", () => {
  const { runs, scores } = mkScoredPairs(12, { retrieval: 2, quality: 2 }, { retrieval: 1, quality: 4 });
  const report = buildReport({ runs, scores, caseStrata: strataFor(runs) });
  assert.equal(report.quality.meanDelta, -2);
  assert.equal(report.quality.qualityDegradationRuledOut, false);
  assert.equal(report.claim.decision, "mixed");
});

test("buildReport: unfavorable primary yields worse; small effect yields inconclusive", () => {
  const worse = mkScoredPairs(12, { retrieval: 0, quality: 3 }, { retrieval: 1, quality: 3 });
  const worseReport = buildReport({ runs: worse.runs, scores: worse.scores, caseStrata: strataFor(worse.runs) });
  assert.equal(worseReport.claim.decision, "worse");
  const flat = mkScoredPairs(12, { retrieval: 1, quality: 3 }, { retrieval: 1, quality: 3 });
  const flatReport = buildReport({ runs: flat.runs, scores: flat.scores, caseStrata: strataFor(flat.runs) });
  assert.equal(flatReport.claim.decision, "inconclusive");
});

test("buildReport: a truncated sample cannot claim superiority even when favorable", () => {
  const { runs, scores } = mkScoredPairs(11, { retrieval: 2, quality: 3 }, { retrieval: 1, quality: 3 });
  const report = buildReport({
    runs,
    scores,
    caseStrata: strataFor(runs),
    expectedPairs: [...runs.filter((r) => r.arm === "E").map((r) => r.pairId), "p-never-run"],
  });
  assert.equal(report.outcomeInventory.truncated, true);
  assert.equal(report.claim.decision, "inconclusive");
  assert.ok(report.claim.reasons.some((r) => r.includes("truncated")));
});

test("buildReport: unresolved score exclusions or adjudications block superiority", () => {
  const { runs, scores } = mkScoredPairs(12, { retrieval: 2, quality: 3 }, { retrieval: 1, quality: 3 });
  // one E score missing: the pair leaves the graded subset (never zero-filled)
  const kept = scores.filter((s) => s.runId !== runs[0].runId);
  const report = buildReport({ runs, scores: kept, caseStrata: strataFor(runs) });
  assert.equal(report.primary.nPairs, 11);
  assert.equal(report.primary.meanDelta, 1); // graded subset is favorable
  assert.equal(report.excludedFromPaired.length, 1);
  assert.match(report.excludedFromPaired[0].reason, /missing score/);
  assert.equal(report.claim.decision, "inconclusive");
  assert.ok(report.claim.reasons.some((r) => r.includes("graded subset")));
  // pending adjudications block superiority the same way
  const pending = buildReport({
    runs,
    scores,
    caseStrata: strataFor(runs),
    scoringSummary: { agreementRate: 10 / 12, adjudicationCount: 2, missingScoreCount: 0 },
  });
  assert.equal(pending.claim.decision, "inconclusive");
  assert.ok(pending.claim.reasons.some((r) => r.includes("unresolved")));
});

test("buildReport: conservative sensitivity uses failure scores for incomplete runs", () => {
  const { runs, scores } = mkScoredPairs(12, { retrieval: 2, quality: 3 }, { retrieval: 1, quality: 3 });
  // two E runs timed out: conservative analysis zeroes them, main keeps scores
  runs[0] = { ...runs[0], status: "timeout" }; // pair p0, arm E
  runs[2] = { ...runs[2], status: "timeout" }; // pair p1, arm E
  const report = buildReport({ runs, scores, caseStrata: strataFor(runs) });
  assert.equal(report.primary.meanDelta, 1); // main analysis uses actual scores
  // conservative: 10 pairs at +1, 2 pairs at -1 (E zeroed to 0, C stays 1) -> 8/12
  assert.equal(report.conservativePrimary.meanDelta, 8 / 12);
  assert.equal(report.claim.decision, "superior"); // 0.667 >= 0.25 and interval excludes zero
});

test("decideClaim: reason strings name the failing gate", () => {
  const point = (v: number) => ({ meanDelta: v, ci: { level: 0.95, lo: v, hi: v, resamples: 10, seed: 1 } });
  const base = {
    primary: point(1),
    conservative: point(1),
    quality: point(0),
    eCriticalViolations: 0,
    truncated: false,
    unresolvedExclusions: 0,
    familySpecific: false,
  };
  assert.equal(decideClaim(base).decision, "superior");
  assert.equal(decideClaim({ ...base, conservative: point(0) }).decision, "mixed");
  assert.equal(decideClaim({ ...base, eCriticalViolations: 2 }).decision, "mixed");
  assert.equal(decideClaim({ ...base, familySpecific: true }).decision, "mixed");
  assert.equal(decideClaim({ ...base, truncated: true }).decision, "inconclusive");
  assert.equal(decideClaim({ ...base, unresolvedExclusions: 1 }).decision, "inconclusive");
  assert.equal(decideClaim({ ...base, primary: point(-1) }).decision, "worse");
  assert.equal(decideClaim({ ...base, primary: point(0.1) }).decision, "inconclusive");
});

// ---------------------------------------------------------------------------
// Trigger timing: censored latency is not a zero-time success
// ---------------------------------------------------------------------------

test("trigger timings: latency from opportunity, censoring without dispatch", () => {
  const run = mkRun({
    pairId: "p",
    arm: "E",
    elapsedMs: 9000,
    events: [
      { id: "e1", type: "dispatch", ts: 0 },
      { id: "e2", type: "tool_result", ts: 4000 }, // decisive local miss
      { id: "e3", type: "tool_call", ts: 7000 }, // first external dispatch
    ],
  });
  const t = triggerTimings(
    [run],
    [{ runId: run.runId, opportunityEventId: "e2", firstExternalDispatchEventId: "e3", firstParallelDispatchEventId: null }],
  );
  assert.equal(t.problems.length, 0);
  assert.equal(t.rows[0].externalLatencyMs, 3000);
  assert.equal(t.rows[0].externalCensored, false);
  assert.equal(t.rows[0].parallelCensored, false);
  assert.equal(t.rows[0].parallelApplicable, false); // another public route can settle the gap
  const required = triggerTimings([run], [{runId:run.runId,opportunityEventId:'e2',firstExternalDispatchEventId:'e3',firstParallelDispatchEventId:null,parallelOpportunityEventId:'e3'}]);
  assert.equal(required.rows[0].parallelApplicable, true);
  assert.equal(required.rows[0].parallelCensored, true);
  // no dispatch at all: censored at run end, latency null
  const t2 = triggerTimings(
    [run],
    [{ runId: run.runId, opportunityEventId: "e2", firstExternalDispatchEventId: null }],
  );
  assert.equal(t2.rows[0].externalLatencyMs, null);
  assert.equal(t2.rows[0].externalCensored, true);
  assert.equal(t2.rows[0].externalCensoredAfterMs, 5000); // 9000 - 4000
  // unknown event references are problems, not silent zeros
  const t3 = triggerTimings([run], [{ runId: run.runId, opportunityEventId: "nope", firstExternalDispatchEventId: null }]);
  assert.equal(t3.rows.length, 0);
  assert.equal(t3.problems.length, 1);
});

// ---------------------------------------------------------------------------
// Scoring: neutralization, gold normalization, validation, disagreements
// ---------------------------------------------------------------------------

test("neutralizeEvents: capability labels replace tool names, errors survive", () => {
  const events = [
    {
      id: "e1",
      type: "tool_call",
      tool: "parallel_search",
      input: { command: 'parallel-cli search "asyncio taskgroup"' },
      error: "parallel-cli exited 1: PARALLEL_API_KEY rejected",
    },
    { id: "e2", type: "tool_call", tool: "bash" }, // common tool: not flagged
    { id: "e3", type: "tool_call", tool: "mystery_tool" }, // unmapped: blinding leak
  ];
  const n = neutralizeEvents(events);
  const [e1, e2, e3] = n.events;
  assert.equal(e1.tool, "capability_web_search");
  assert.equal((e1.input as any).command, 'capability_research_cli search "asyncio taskgroup"');
  // the error is still present and still an error; only names were substituted
  assert.equal(typeof e1.error, "string");
  assert.match(e1.error as string, /exited 1/);
  assert.ok(!(e1.error as string).includes("parallel-cli"));
  assert.ok(!(e1.error as string).includes("PARALLEL_API_KEY"));
  assert.equal(e2.tool, "bash");
  assert.equal(e3.tool, "mystery_tool"); // never rewritten without a label
  assert.deepEqual(n.unmappedToolNames, ["mystery_tool"]);
  assert.ok(n.replacements >= 4);
  // input events are not mutated
  assert.equal(events[0].tool, "parallel_search");
});

test("neutralizeEvents preserves event payload text (regression: wiped strings)", () => {
  const events = [
    {
      id: "e1",
      type: "tool_call",
      tool: "parallel_search",
      ts: 5,
      input: { query: "asyncio TaskGroup" },
      output: "parallel_search returned 5 results; first: TaskGroup docs",
      error: null,
    },
  ];
  const [e] = neutralizeEvents(events).events;
  assert.equal(e.tool, "capability_web_search");
  // text with no tool names is preserved verbatim, not wiped
  assert.deepEqual(e.input, { query: "asyncio TaskGroup" });
  assert.equal(e.output, "capability_web_search returned 5 results; first: TaskGroup docs");
  assert.equal(e.error, null);
  assert.equal(e.ts, 5);
  assert.equal(e.type, "tool_call");
});

const GOLD_FILE = {
  schema_version: "1",
  kind: "benchmark-gold-packets",
  visibility: "evaluator-only; gold packets never enter the agent workspace",
  cases: {
    X1: {
      sourceFamily: "fam-x",
      workspace_files: { "notes.md": "hypothesis" },
      rubric: "Grade against the frozen passage.",
      requiredClaims: [
        { id: "X1-c1", text: "claim one", sourceIds: ["src-1"] },
        { id: "X1-c2", text: "claim two", sourceIds: [] },
      ],
      sources: [
        {
          id: "src-1",
          kind: "official_public_source",
          url: "https://example.com/x",
          file: "gold-sources/x.html",
          retrieved_utc: "2026-09-20T00:00:00Z",
          sha256: "abc123",
          bytes: 10,
          passage_match: "normalized_html_text",
          evidence_passages: ["passage text"],
        },
      ],
    },
  },
};

test("normalizeGold: adapts the on-disk gold schema, drops evaluator-only fields", () => {
  const gold = normalizeGold(GOLD_FILE, "X1");
  assert.equal(gold.caseId, "X1");
  assert.equal(gold.claimCount, 2);
  assert.equal(gold.rubric, "Grade against the frozen passage.");
  assert.equal(gold.requiredClaims[0].id, "X1-c1");
  assert.deepEqual(gold.requiredClaims[0].sourceIds, ["src-1"]);
  assert.equal(gold.sources[0].evidencePassages[0], "passage text");
  assert.ok(!("sha256" in gold.sources[0])); // evaluator-only fields stay out
  assert.ok(!("file" in gold.sources[0]));
  assert.throws(() => normalizeGold(GOLD_FILE, "ZZ"), /no packet/);
  assert.throws(() => normalizeGold({ cases: { X1: { rubric: "r", requiredClaims: [] } } }, "X1"), /requiredClaims/);
});

test("buildRaterInput: normalized gold only, neutralized events, no arm metadata", () => {
  const gold = normalizeGold(GOLD_FILE, "X1");
  const run = mkRun({
    pairId: "px",
    arm: "E",
    caseId: "X1",
    events: [{ id: "e1", type: "tool_call", tool: "parallel_extract" }],
  });
  const ri = buildRaterInput(run, gold, { prompt: "task prompt" });
  assert.equal(ri.caseId, "X1");
  assert.equal(ri.runId, run.runId);
  assert.equal(ri.events[0].tool, "capability_url_extract");
  assert.equal(ri.gold.requiredClaims.length, 2);
  assert.equal(ri.gold.sources[0].evidencePassages[0], "passage text");
  // nothing arm-identifying or evaluator-only leaks into the rater input
  const serialized = JSON.stringify(ri);
  assert.ok(!serialized.includes('"arm"'));
  assert.ok(!serialized.includes("parallel_extract"));
  assert.ok(!serialized.includes("sha256"));
  assert.equal(ri.blinding.neutralizedToolNames, true);
  assert.throws(() => buildRaterInput(run, { ...gold, caseId: "D1" }));
});

test("validateScore: ranges, real event IDs, citation requirement", () => {
  const run = mkRun({ pairId: "p", arm: "E" });
  assert.deepEqual(validateScore(mkScore(run.runId), run), []);
  // out-of-range and non-integer values
  assert.ok(validateScore(mkScore(run.runId, { quality: 5 }), run).some((e) => e.includes("quality")));
  assert.ok(validateScore(mkScore(run.runId, { retrieval: 1.5 }), run).some((e) => e.includes("retrieval")));
  assert.ok(validateScore(mkScore(run.runId, { supportedClaims: -1 }), run).some((e) => e.includes("supportedClaims")));
  // evidence citations must reference actual event IDs of this run
  assert.ok(validateScore(mkScore(run.runId, { evidenceEventIds: ["ghost"] }), run).some((e) => e.includes("ghost")));
  // penalties/awarded points require at least one cited event
  assert.ok(validateScore(mkScore(run.runId, { evidenceEventIds: [] }), run).some((e) => e.includes("cite")));
  // unknown keys are rejected (structured output), metadata is the extension point
  assert.ok(validateScore({ ...mkScore(run.runId), extra: 1 }, run).some((e) => e.includes("unknown key")));
  const withRaterMeta = mkScore(run.runId, {
    metadata: {
      rater: "grok-4.6",
      evidence: [
        { criterion: "quality.support", outcome: "awarded" as const, eventIds: ["e1"] },
        { criterion: "quality.uncertainty", outcome: "penalty" as const, eventIds: ["e1"] },
      ],
    },
  });
  assert.deepEqual(validateScore(withRaterMeta, run), []);
  // runId mismatch
  assert.ok(validateScore(mkScore("other-run"), run).some((e) => e.includes("runId")));
  // zero-event run: citations impossible, notes must carry the basis
  const empty = mkRun({ pairId: "p2", arm: "E", events: [] });
  const noEvidence = mkScore(empty.runId, { evidenceEventIds: [], metadata: undefined, notes: "" });
  assert.ok(validateScore(noEvidence, empty).some((e) => e.includes("no citable events")));
  assert.deepEqual(
    validateScore({ ...noEvidence, notes: "run denied before dispatch" }, empty),
    [],
  );
});

test("validateScore: event-level per-criterion citations are enforced", () => {
  const run = mkRun({ pairId: "p", arm: "E" });
  // quality 3 without the penalty entry for the unawarded fourth point
  const noPenalty = mkScore(run.runId, {
    metadata: { evidence: [{ criterion: "quality.support", outcome: "awarded" as const, eventIds: ["e1"] }] },
  });
  assert.ok(validateScore(noPenalty, run).some((e) => e.includes("quality < 4")));
  // flagged violation without a matching penalty entry
  assert.ok(
    validateScore(mkScore(run.runId, { criticalViolation: true }), run).some((e) => e.includes("criticalViolation")),
  );
  const flagWithEvidence = mkScore(run.runId, {
    criticalViolation: true,
    metadata: {
      evidence: [
        { criterion: "criticalViolation", outcome: "penalty" as const, eventIds: ["e1"] },
        { criterion: "quality.support", outcome: "awarded" as const, eventIds: ["e1"] },
        { criterion: "quality.coverage", outcome: "penalty" as const, eventIds: ["e1"] },
      ],
    },
  });
  assert.deepEqual(validateScore(flagWithEvidence, run), []);
  // unknown event id inside a per-criterion entry
  const badId = mkScore(run.runId, {
    metadata: {
      evidence: [
        { criterion: "quality.support", outcome: "awarded" as const, eventIds: ["ghost"] },
        { criterion: "quality.uncertainty", outcome: "penalty" as const, eventIds: ["e1"] },
      ],
    },
  });
  assert.ok(validateScore(badId, run).some((e) => e.includes("ghost")));
});

test("validateScore: supportedClaims bounded by the gold claim count", () => {
  const gold = normalizeGold(GOLD_FILE, "X1"); // 2 claims
  const run = mkRun({ pairId: "px", arm: "E", caseId: "X1" });
  assert.ok(
    validateScore(mkScore(run.runId, { supportedClaims: 3 }), run, { gold }).some((e) => e.includes("exceeds")),
  );
  assert.deepEqual(validateScore(mkScore(run.runId, { supportedClaims: 2 }), run, { gold }), []);
  // gold/run case mismatch is an error, not a skipped check
  const other = mkRun({ pairId: "py", arm: "E", caseId: "D1" });
  assert.ok(validateScore(mkScore(other.runId), other, { gold }).some((e) => e.includes("does not match")));
});

test("adjudication queue: judgment disagreements queued, citation-only differences preserved", () => {
  const run1 = mkRun({ pairId: "p1", arm: "E", events: [{ id: "e1", type: "a" }, { id: "e2", type: "b" }] });
  const run2 = mkRun({ pairId: "p2", arm: "E" });
  const a1 = mkScore(run1.runId, { quality: 3, evidenceEventIds: ["e1"] });
  const b1 = mkScore(run1.runId, { quality: 4, supportedClaims: 2, evidenceEventIds: ["e2"] });
  // identical judgments, different but individually valid citation choices
  const a2 = mkScore(run2.runId, { evidenceEventIds: ["e1"] });
  const b2 = mkScore(run2.runId, { evidenceEventIds: ["e1"] });
  const res = buildAdjudicationQueue([
    { a: a1, b: b1 },
    { a: a2, b: b2 },
  ]);
  assert.equal(res.queue.length, 1);
  assert.deepEqual(res.agreedRunIds, [run2.runId]);
  assert.equal(res.agreementRate, 0.5);
  const item = res.queue[0];
  assert.equal(item.status, "awaiting_operator");
  assert.deepEqual(item.fields.map((f) => f.field).sort(), ["quality", "supportedClaims"]);
  // both original judgments and citation sets travel with the item; nothing merged
  assert.equal(item.raterA.quality, 3);
  assert.equal(item.raterB.quality, 4);
  assert.deepEqual(item.citationSets, { raterA: ["e1"], raterB: ["e2"] });
  assert.equal(buildAdjudicationQueue([]).agreementRate, null);
  assert.throws(() => compareScores(a1, mkScore("different")));
});

test("citation-only differences never enter the adjudication queue", () => {
  const run = mkRun({ pairId: "p", arm: "E", events: [{ id: "e1", type: "a" }, { id: "e2", type: "b" }] });
  const a = mkScore(run.runId, { evidenceEventIds: ["e1"] });
  const b = mkScore(run.runId, { evidenceEventIds: ["e2"] });
  assert.deepEqual(compareScores(a, b), []); // citations are not judgments
  const res = buildAdjudicationQueue([{ a, b }]);
  assert.equal(res.queue.length, 0);
  assert.equal(res.agreementRate, 1);
  assert.deepEqual(res.citationOnlyDifferences, [{ runId: run.runId, raterA: ["e1"], raterB: ["e2"] }]);
});

test("missing scores are listed explicitly, duplicates surfaced", () => {
  const r1 = mkRun({ pairId: "p1", arm: "E" });
  const r2 = mkRun({ pairId: "p1", arm: "C", status: "timeout" });
  const missing = missingScores([r1, r2], [mkScore(r1.runId)]);
  assert.deepEqual(missing, [
    { runId: r2.runId, caseId: r2.caseId, arm: "C", status: "timeout", reason: "missing_score" },
  ]);
  const { map, duplicateRunIds } = scoresByRun([mkScore(r1.runId), mkScore(r1.runId, { quality: 4 })]);
  assert.equal(map.get(r1.runId)!.quality, 3); // first wins
  assert.deepEqual(duplicateRunIds, [r1.runId]);
});

function mkOverlay(
  runId: string,
  fields: FinalAdjudicationRecord["fields"],
): FinalAdjudicationRecord {
  return {
    runId,
    adjudicator: "grok-4.6-council-pass",
    independentThirdModel: false,
    sameFamilyAs: "raterA (Grok 4.6)",
    notRaterConsensus: true,
    provenance: {
      goldCaseId: "X",
      goldRubric: "r",
      runPath: "run.json",
      raterAPath: "a.json",
      raterBPath: "b.json",
      originalQueuePath: "adjudication.json",
    },
    rationale: "overlay",
    fields,
    evidenceEventIds: ["e1"],
    notes: "overlay notes",
  };
}

test("final overlay copies named rater values without mutating originals or inventing agreement", () => {
  const run = mkRun({ pairId: "p", arm: "E", events: [{ id: "e1", type: "a" }, { id: "e2", type: "b" }] });
  const a = mkScore(run.runId, { quality: 3, supportedClaims: 0, fabricatedCitation: true, evidenceEventIds: ["e1"] });
  const b = mkScore(run.runId, { quality: 2, supportedClaims: 1, fabricatedCitation: false, evidenceEventIds: ["e2"] });
  const queue = buildAdjudicationQueue([{ a, b }]);
  assert.equal(queue.queue.length, 1);
  const item = queue.queue[0];
  const rec = mkOverlay(run.runId, [
    {
      field: "quality",
      value: 2,
      source: "raterB",
      rubricClause: "quality support",
      evidenceEventIds: ["e1"],
      rationale: "copy B quality",
    },
    {
      field: "fabricatedCitation",
      value: false,
      source: "raterB",
      rubricClause: "fabricated citation",
      evidenceEventIds: ["e1"],
      rationale: "copy B flag",
    },
    {
      field: "supportedClaims",
      value: 0,
      source: "raterA",
      rubricClause: "supportedClaims",
      evidenceEventIds: ["e1"],
      rationale: "copy A claims",
    },
  ]);
  const applied = overlayFinalScore(item, rec);
  assert.equal(applied.quality, 2);
  assert.equal(applied.fabricatedCitation, false);
  assert.equal(applied.supportedClaims, 0);
  assert.equal(applied.notes, "overlay notes");
  assert.equal(item.raterA.quality, 3);
  assert.equal(item.raterA.fabricatedCitation, true);
  assert.equal(item.raterB.supportedClaims, 1);
  assert.equal(item.status, "awaiting_operator");
  assert.equal(compareScores(item.raterA, item.raterB).length, 3);
  assert.equal(applied.metadata?.finalAdjudication && (applied.metadata.finalAdjudication as { independentThirdModel: boolean }).independentThirdModel, false);
  const mixed = applyFinalAdjudications([mkScore("agreed")], queue.queue, [rec]);
  assert.equal(mixed.remaining.length, 0);
  assert.equal(mixed.applied.length, 1);
  assert.equal(mixed.scores.length, 2);
  assert.equal(mixed.scores.find((s) => s.runId === "agreed")!.quality, 3);
});

test("final overlay leaves unresolved items and rejects invented or extra fields", () => {
  const r1 = mkRun({ pairId: "p1", arm: "E" });
  const r2 = mkRun({ pairId: "p2", arm: "E" });
  const q = buildAdjudicationQueue([
    { a: mkScore(r1.runId, { quality: 3 }), b: mkScore(r1.runId, { quality: 2 }) },
    { a: mkScore(r2.runId, { retrieval: 1 }), b: mkScore(r2.runId, { retrieval: 2 }) },
  ]);
  const one = mkOverlay(r1.runId, [
    {
      field: "quality",
      value: 2,
      source: "raterB",
      rubricClause: "q",
      evidenceEventIds: ["e1"],
      rationale: "b",
    },
  ]);
  const partial = applyFinalAdjudications([], q.queue, [one]);
  assert.deepEqual(partial.remaining.map((x) => x.runId), [r2.runId]);
  assert.equal(partial.applied[0].quality, 2);
  assert.throws(() =>
    overlayFinalScore(q.queue[0], mkOverlay(r1.runId, [
      { field: "quality", value: 4, source: "raterB", rubricClause: "q", evidenceEventIds: ["e1"], rationale: "invented" },
    ])),
  );
  assert.throws(() =>
    overlayFinalScore(q.queue[0], mkOverlay(r1.runId, [
      { field: "quality", value: 2, source: "raterB", rubricClause: "q", evidenceEventIds: ["e1"], rationale: "b" },
      { field: "retrieval", value: 2, source: "raterB", rubricClause: "r", evidenceEventIds: ["e1"], rationale: "extra" },
    ])),
  );
  assert.throws(() => applyFinalAdjudications([], q.queue, [mkOverlay("missing", [])]));
});

test("buildReport uses remaining adjudicationCount; overlay does not average rater corpora", () => {
  const { runs, scores } = mkScoredPairs(12, { retrieval: 1, quality: 3 }, { retrieval: 1, quality: 3 });
  const withPending = buildReport({
    runs,
    scores,
    caseStrata: strataFor(runs),
    scoringSummary: { agreementRate: 0.75, adjudicationCount: 6, missingScoreCount: 0 },
  });
  assert.equal(withPending.claim.decision, "inconclusive");
  const resolved = buildReport({
    runs,
    scores,
    caseStrata: strataFor(runs),
    scoringSummary: { agreementRate: 0.75, adjudicationCount: 0, missingScoreCount: 0, finalOverlayCount: 6 },
  });
  assert.equal(resolved.claim.decision, "inconclusive"); // mean delta 0, interval includes 0
  assert.equal(resolved.scoringSummary?.finalOverlayCount, 6);
  assert.equal(resolved.primary.meanDelta, 0);
});

test("frozen Grok overlay file applies to the original queue without mutating rater scores", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const root = dirname(import.meta.dirname);
  const overlayPath = join(root, "bench/final-adjudication.json");
  const queuePath = join(root, ".pi/benchmark/data/grading/primary/adjudication.json");
  const agreedPath = join(root, ".pi/benchmark/data/grading/primary/agreed-scores.json");
  const grokA1C = join(root, ".pi/benchmark/data/grading/primary/r-ad7540aa10de23.round2.grok.json");
  if (!existsSync(queuePath) || !existsSync(agreedPath)) return; // dataset not mounted
  const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
  const queueFile = JSON.parse(readFileSync(queuePath, "utf8"));
  const agreed = JSON.parse(readFileSync(agreedPath, "utf8"));
  const before = existsSync(grokA1C) ? readFileSync(grokA1C, "utf8") : "";
  assert.equal(overlay.independentThirdModel, false);
  assert.equal(queueFile.queue.length, 6);
  const applied = applyFinalAdjudications(agreed, queueFile.queue, overlay.records);
  assert.equal(applied.remaining.length, 0);
  assert.equal(applied.applied.length, 6);
  assert.equal(applied.scores.length, agreed.length + 6);
  assert.equal(queueFile.queue[0].raterA.quality, 3);
  assert.equal(queueFile.queue[0].raterB.quality, 2);
  const a1c = applied.applied.find((s) => s.runId === "primary-A1-C");
  const r2e = applied.applied.find((s) => s.runId === "primary-R2-E");
  assert.equal(a1c?.quality, 2);
  assert.equal(a1c?.supportedClaims, 1);
  assert.equal(r2e?.fabricatedCitation, false);
  assert.equal(r2e?.supportedClaims, 2);
  assert.notEqual(r2e?.fabricatedCitation, queueFile.queue.find((q: { runId: string }) => q.runId === "primary-R2-E").raterA.fabricatedCitation);
  if (before) assert.equal(readFileSync(grokA1C, "utf8"), before);
});
