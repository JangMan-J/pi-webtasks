// bench/report.ts — pure statistics and report pipeline for the E-vs-C benchmark.
//
// Scope: paired statistics, cost tables, and the complete outcome inventory per
// docs/benchmark-plan.md §7–§8. Every attempted, incomplete, and censored outcome
// stays in the inventory; unsuccessful runs are censored at the deadline for time
// analysis and receive conservative failure scores for the superiority sensitivity
// check. This module is pure: no I/O, no clocks, no paid APIs, no model graders.
//
// Usage contract (stable for bench/run.ts integration):
//   - RunRecord / RunScore below are the agreed interfaces; `metadata` is the
//     extensibility point on both.
//   - buildReport(input) is the single entry point and is deterministic for a
//     given input (bootstrap seed fixed at 42017 unless overridden in opts).
//   - All endpoints report paired deltas as E minus C.

export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 42_017;
export const CI_LEVEL = 0.95;
/** Preregistered engineering margins (plan §8); not psychometric thresholds. */
export const SUPERIORITY_MARGIN = 0.25; // on the 0–2 retrieval scale
export const QUALITY_NI_MARGIN = 0.25; // on the 0–4 quality scale

export type Arm = "E" | "C";

// Aligned with bench/run.ts status assignment; "unattempted" is the
// report-side placeholder for expected pairs that never produced a run.
export const RUN_STATUSES = [
  "completed",
  "failed",
  "timeout",
  "limit",
  "audit_failed",
  "harness_error",
  "unattempted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunUsage {
  input: number; // uncached input tokens
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning?: number; // reported separately; never added twice
  [k: string]: unknown;
}

export interface RunEvent {
  id: string;
  type: string;
  ts?: number; // ms since run dispatch, when measurable
  [k: string]: unknown;
}

export interface RunRecord {
  runId: string;
  pairId: string;
  caseId: string;
  phase: string; // "pilot" | "primary" | "replication" | "diagnostics"
  arm: Arm;
  status: RunStatus;
  elapsedMs: number;
  deadlineMs: number;
  usage: RunUsage;
  /**
   * Conservative reserved Parallel liability in microdollars. Optional while
   * the runner base record awaits the gateway API: a missing field is unknown,
   * not verified zero, and is counted explicitly in the cost table.
   */
  parallelLiabilityMicro?: number;
  events: RunEvent[];
  answer: string;
  sourceFamily: string;
  // Optional runner-supplied extras from bench/run.ts base records.
  model?: string;
  processElapsedMs?: number;
  answers?: string[];
  harnessError?: boolean;
  manifestHash?: string;
  metadata?: Record<string, unknown>;
}

export interface RunScore {
  runId: string;
  retrieval: number; // integer 0..2
  quality: number; // integer 0..4
  criticalViolation: boolean;
  materialWrong: boolean;
  fabricatedCitation: boolean;
  evidenceEventIds: string[];
  supportedClaims: number;
  notes: string;
  metadata?: Record<string, unknown>;
}

export type Stratum = "web" | "no_web";

export interface ConfidenceInterval {
  level: number;
  lo: number;
  hi: number;
  resamples: number;
  seed: number;
}

export interface SignTestResult {
  n: number; // nonzero pairs
  positives: number;
  negatives: number;
  p: number; // exact two-sided
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  if (xs.length === 0) throw new Error("mean of empty array");
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty array");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Context tokens: disjoint fields summed once (plan §7). Reasoning excluded. */
export function contextTokens(u: RunUsage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

/** Deterministic PRNG so the 10,000-resample bootstrap is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EndpointOptions {
  resamples?: number;
  seed?: number;
  level?: number;
}

/**
 * Paired bootstrap over task pairs: resample pairs with replacement, take the
 * mean delta each time, report percentile bounds. The interval describes this
 * fixed task mix; it is not a population confidence claim across unseen domains.
 */
export function bootstrapPairedInterval(
  deltas: number[],
  opts: EndpointOptions = {},
): { meanDelta: number; ci: ConfidenceInterval } {
  if (deltas.length === 0) throw new Error("bootstrap of empty deltas");
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const seed = opts.seed ?? BOOTSTRAP_SEED;
  const level = opts.level ?? CI_LEVEL;
  const rng = mulberry32(seed);
  const means = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) {
      sum += deltas[Math.floor(rng() * deltas.length)];
    }
    means[r] = sum / deltas.length;
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - level;
  const loIdx = Math.max(0, Math.min(resamples - 1, Math.floor((alpha / 2) * resamples)));
  const hiIdx = Math.max(0, Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1));
  return {
    meanDelta: mean(deltas),
    ci: { level, lo: means[loIdx], hi: means[hiIdx], resamples, seed },
  };
}

function logFact(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/** Exact two-sided paired sign test; ties (delta 0) are excluded. */
export function exactSignTest(deltas: number[]): SignTestResult {
  const nz = deltas.filter((d) => d !== 0);
  const n = nz.length;
  const positives = nz.filter((d) => d > 0).length;
  if (n === 0) return { n: 0, positives: 0, negatives: 0, p: 1 };
  const prob = (k: number) =>
    Math.exp(logFact(n) - logFact(k) - logFact(n - k) - n * Math.LN2);
  let lower = 0;
  for (let k = 0; k <= positives; k++) lower += prob(k);
  let upper = 0;
  for (let k = positives; k <= n; k++) upper += prob(k);
  return {
    n,
    positives,
    negatives: n - positives,
    p: Math.min(1, 2 * Math.min(lower, upper)),
  };
}

// ---------------------------------------------------------------------------
// Success classification and conservative failure scores
// ---------------------------------------------------------------------------

/**
 * Successful resolution: terminal success status, quality >= 3, no material
 * wrong conclusion, no critical boundary violation, no fabricated citation
 * (a fabricated material citation fails the run regardless of points, plan §7).
 */
export function isSuccessful(run: RunRecord, score: RunScore | undefined): boolean {
  return (
    run.status === "completed" &&
    !!score &&
    score.quality >= 3 &&
    !score.materialWrong &&
    !score.criticalViolation &&
    !score.fabricatedCitation
  );
}

/**
 * Conservative failure scores (plan §8 sensitivity condition): any run that did
 * not reach a terminal success — including timeouts, errors, budget denials,
 * and runs with missing scores — receives retrieval 0, quality 0, and 0
 * supported claims. Scored violation flags are preserved (they are penalties,
 * not credit). The original scores remain untouched in the main analysis.
 */
export function conservativeScore(run: RunRecord, score: RunScore | undefined): RunScore {
  if (run.status === "completed" && score) return score;
  return {
    runId: run.runId,
    retrieval: 0,
    quality: 0,
    criticalViolation: score?.criticalViolation ?? false,
    materialWrong: score?.materialWrong ?? false,
    fabricatedCitation: score?.fabricatedCitation ?? false,
    evidenceEventIds: score?.evidenceEventIds ?? [],
    supportedClaims: 0,
    notes: score
      ? `conservative failure score for status=${run.status}`
      : `conservative failure score: missing score, status=${run.status}`,
  };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface PairedRuns {
  pairId: string;
  caseId: string;
  sourceFamily: string;
  e?: RunRecord;
  c?: RunRecord;
  anomalies: string[];
}

export function pairRuns(runs: RunRecord[]): PairedRuns[] {
  const byPair = new Map<string, PairedRuns>();
  for (const r of runs) {
    let p = byPair.get(r.pairId);
    if (!p) {
      p = { pairId: r.pairId, caseId: r.caseId, sourceFamily: r.sourceFamily, anomalies: [] };
      byPair.set(r.pairId, p);
    }
    if (p.caseId !== r.caseId) p.anomalies.push(`caseId mismatch: ${p.caseId} vs ${r.caseId}`);
    if (p.sourceFamily !== r.sourceFamily) {
      p.anomalies.push(`sourceFamily mismatch: ${p.sourceFamily} vs ${r.sourceFamily}`);
    }
    const slot = r.arm === "E" ? "e" : "c";
    if (p[slot]) p.anomalies.push(`duplicate ${r.arm} run in pair ${r.pairId}`);
    else p[slot] = r;
  }
  return [...byPair.values()];
}

export interface ScoredPair {
  pair: PairedRuns;
  eRun: RunRecord;
  cRun: RunRecord;
  eScore: RunScore;
  cScore: RunScore;
}

export interface PairSelection {
  scored: ScoredPair[];
  excluded: { pairId: string; caseId: string; reason: string }[];
}

/**
 * Select complete pairs for paired statistics. Runs missing an arm are
 * excluded from deltas but stay visible through the outcome inventory.
 * With conservative=true, missing scores become explicit failure scores;
 * otherwise a missing score excludes the pair with a stated reason.
 */
export function selectScoredPairs(
  pairs: PairedRuns[],
  scoreByRun: ReadonlyMap<string, RunScore>,
  opts: { conservative: boolean },
): PairSelection {
  const scored: ScoredPair[] = [];
  const excluded: PairSelection["excluded"] = [];
  for (const pair of pairs) {
    if (!pair.e || !pair.c) {
      excluded.push({
        pairId: pair.pairId,
        caseId: pair.caseId,
        reason: `missing arm ${pair.e ? "C" : "E"}: excluded from paired deltas, kept in outcome inventory`,
      });
      continue;
    }
    const eScore = scoreByRun.get(pair.e.runId);
    const cScore = scoreByRun.get(pair.c.runId);
    if (opts.conservative) {
      scored.push({
        pair,
        eRun: pair.e,
        cRun: pair.c,
        eScore: conservativeScore(pair.e, eScore),
        cScore: conservativeScore(pair.c, cScore),
      });
    } else {
      if (!eScore || !cScore) {
        excluded.push({
          pairId: pair.pairId,
          caseId: pair.caseId,
          reason: `missing score for ${!eScore ? pair.e.runId : pair.c.runId}: explicit missing score, not zero-filled in main analysis`,
        });
        continue;
      }
      scored.push({ pair, eRun: pair.e, cRun: pair.c, eScore, cScore });
    }
  }
  return { scored, excluded };
}

// ---------------------------------------------------------------------------
// Paired endpoint analysis (retrieval and quality intervals)
// ---------------------------------------------------------------------------

export interface EndpointResult {
  nPairs: number;
  deltas: number[]; // raw paired deltas, E minus C, for reproducibility
  meanDelta: number;
  ci: ConfidenceInterval;
  signTest: SignTestResult;
}

export function analyzeEndpoint(
  scored: ScoredPair[],
  pick: (s: RunScore) => number,
  opts: EndpointOptions = {},
): EndpointResult {
  const deltas = scored.map((p) => pick(p.eScore) - pick(p.cScore));
  const { meanDelta, ci } = bootstrapPairedInterval(deltas, opts);
  return { nPairs: deltas.length, deltas, meanDelta, ci, signTest: exactSignTest(deltas) };
}

function isFavorable(r: { meanDelta: number; ci: ConfidenceInterval }): boolean {
  return r.meanDelta >= SUPERIORITY_MARGIN && r.ci.lo > 0;
}

// ---------------------------------------------------------------------------
// Leave-one-source-family-out
// ---------------------------------------------------------------------------

export interface LofoResult {
  droppedFamily: string;
  nPairs: number;
  meanDelta: number;
  ci: ConfidenceInterval;
  favorable: boolean;
}

export function leaveOneFamilyOut(
  scored: ScoredPair[],
  pick: (s: RunScore) => number,
  opts: EndpointOptions = {},
): LofoResult[] {
  const families = [...new Set(scored.map((p) => p.pair.sourceFamily))].sort();
  const out: LofoResult[] = [];
  for (const fam of families) {
    const kept = scored.filter((p) => p.pair.sourceFamily !== fam);
    if (kept.length === 0) continue;
    const r = analyzeEndpoint(kept, pick, opts);
    out.push({
      droppedFamily: fam,
      nPairs: r.nPairs,
      meanDelta: r.meanDelta,
      ci: r.ci,
      favorable: isFavorable(r),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Restricted mean time (unsuccessful runs censored at the common deadline)
// ---------------------------------------------------------------------------

export interface RmstRow {
  pairId: string;
  caseId: string;
  tau: number; // common deadline, min of the two arm deadlines
  eRestrictedMs: number;
  cRestrictedMs: number;
  eCensored: boolean; // unsuccessful: censored at tau, never a zero-time success
  cCensored: boolean;
}

export interface RmstResult {
  rows: RmstRow[];
  perArmMeanMs: { E: number; C: number };
  meanDeltaMs: number; // E minus C; negative favors E on time
  ci: ConfidenceInterval;
  descriptiveSuccessfulMedianMs: { E: number | null; C: number | null };
  note: string;
}

export function restrictedMeanTime(
  pairs: PairedRuns[],
  scoreByRun: ReadonlyMap<string, RunScore>,
  opts: EndpointOptions = {},
): RmstResult {
  const rows: RmstRow[] = [];
  const succE: number[] = [];
  const succC: number[] = [];
  for (const pair of pairs) {
    if (!pair.e || !pair.c) continue;
    const tau = Math.min(pair.e.deadlineMs, pair.c.deadlineMs);
    const eOk = isSuccessful(pair.e, scoreByRun.get(pair.e.runId));
    const cOk = isSuccessful(pair.c, scoreByRun.get(pair.c.runId));
    const eR = eOk ? Math.min(pair.e.elapsedMs, tau) : tau;
    const cR = cOk ? Math.min(pair.c.elapsedMs, tau) : tau;
    if (eOk) succE.push(eR);
    if (cOk) succC.push(cR);
    rows.push({
      pairId: pair.pairId,
      caseId: pair.caseId,
      tau,
      eRestrictedMs: eR,
      cRestrictedMs: cR,
      eCensored: !eOk,
      cCensored: !cOk,
    });
  }
  if (rows.length === 0) throw new Error("restricted mean time needs at least one complete pair");
  const deltas = rows.map((r) => r.eRestrictedMs - r.cRestrictedMs);
  const { meanDelta, ci } = bootstrapPairedInterval(deltas, opts);
  return {
    rows,
    perArmMeanMs: { E: mean(rows.map((r) => r.eRestrictedMs)), C: mean(rows.map((r) => r.cRestrictedMs)) },
    meanDeltaMs: meanDelta,
    ci,
    descriptiveSuccessfulMedianMs: {
      E: succE.length ? median(succE) : null,
      C: succC.length ? median(succC) : null,
    },
    note: "Restricted mean time at the common deadline; unsuccessful runs censored at tau. Successful-only medians are descriptive and can reward fast failures.",
  };
}

// ---------------------------------------------------------------------------
// Token and evidence efficiency (failed and timed-out runs included)
// ---------------------------------------------------------------------------

export interface ArmEfficiency {
  runs: number;
  /** Runs with no score: their tokens count, but a missing score is never silently treated as zero quality. */
  unscoredRuns: number;
  contextTokens: number;
  outputTokens: number;
  sumQuality: number;
  sumSupportedClaims: number;
  qualityPointsPer10kTokens: number | null; // null when denominator is 0
  supportedClaimsPer10kTokens: number | null;
}

export interface EfficiencyResult {
  overall: { E: ArmEfficiency; C: ArmEfficiency };
  byStratum: Record<Stratum, { E: ArmEfficiency; C: ArmEfficiency } | null>;
  note: string;
}

function armEfficiency(runs: RunRecord[], scoreByRun: ReadonlyMap<string, RunScore>): ArmEfficiency {
  let ctx = 0;
  let out = 0;
  let q = 0;
  let claims = 0;
  let unscored = 0;
  for (const r of runs) {
    ctx += contextTokens(r.usage);
    out += r.usage.output;
    const s = scoreByRun.get(r.runId);
    if (!s) unscored++; // explicit: tokens count toward the denominator, no silent zero quality
    q += s?.quality ?? 0;
    claims += s?.supportedClaims ?? 0;
  }
  return {
    runs: runs.length,
    unscoredRuns: unscored,
    contextTokens: ctx,
    outputTokens: out,
    sumQuality: q,
    sumSupportedClaims: claims,
    qualityPointsPer10kTokens: ctx > 0 ? (q * 10_000) / ctx : null,
    supportedClaimsPer10kTokens: ctx > 0 ? (claims * 10_000) / ctx : null,
  };
}

export function tokenEfficiency(
  runs: RunRecord[],
  scoreByRun: ReadonlyMap<string, RunScore>,
  caseStrata: Record<string, Stratum>,
): EfficiencyResult {
  for (const r of runs) {
    if (!caseStrata[r.caseId]) throw new Error(`caseStrata missing entry for case ${r.caseId}`);
  }
  const byArm = (rs: RunRecord[]) => ({
    E: armEfficiency(rs.filter((r) => r.arm === "E"), scoreByRun),
    C: armEfficiency(rs.filter((r) => r.arm === "C"), scoreByRun),
  });
  const strata: Stratum[] = ["web", "no_web"];
  const byStratum = {} as EfficiencyResult["byStratum"];
  for (const s of strata) {
    const rs = runs.filter((r) => caseStrata[r.caseId] === s);
    byStratum[s] = rs.length ? byArm(rs) : null;
  }
  return {
    overall: byArm(runs),
    byStratum,
    note: "Includes failed and timed-out runs. Neither ratio rewards an unsupported short answer: unsupported claims earn no quality or claim credit in scoring. Null ratio means zero context tokens, reported as N/A rather than given an artificial denominator. Unscored runs contribute tokens to the denominator and are counted in unscoredRuns; a missing score is uncertainty, not zero quality.",
  };
}

// ---------------------------------------------------------------------------
// Costs: service liability kept distinct from model token costs
// ---------------------------------------------------------------------------

export interface ModelPrices {
  uncachedInputPerM: number; // USD per million tokens
  cacheReadPerM: number;
  cacheWritePerM: number;
  outputPerM: number;
}

export interface ArmCost {
  runs: number;
  /** Runs whose record carries no liability field (gateway API pending): unknown, not zero. */
  runsWithoutLiability: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  contextTokens: number;
  parallelLiabilityMicro: number;
  parallelLiabilityUsd: number;
  supportedClaimsTotal: number;
  parallelSupportedClaims: number;
  runsWithoutAttribution: number;
  claimsPerParallelDollar: number | null; // null (N/A) in zero-spend strata
  modelCostUsd: number | null; // null without explicit prices: unknown, not zero
}

export interface CostResult {
  E: ArmCost;
  C: ArmCost;
  notes: string[];
}

export function costTable(
  runs: RunRecord[],
  scoreByRun: ReadonlyMap<string, RunScore>,
  modelPrices?: ModelPrices,
): CostResult {
  const per = (arm: Arm): ArmCost => {
    const rs = runs.filter((r) => r.arm === arm);
    let input = 0;
    let cr = 0;
    let cw = 0;
    let out = 0;
    let micro = 0;
    let claims = 0;
    let parallelClaims = 0;
    let noAttribution = 0;
    let noLiability = 0;
    for (const r of rs) {
      input += r.usage.input;
      cr += r.usage.cacheRead;
      cw += r.usage.cacheWrite;
      out += r.usage.output;
      if (r.parallelLiabilityMicro === undefined) noLiability++;
      else micro += r.parallelLiabilityMicro;
      const score = scoreByRun.get(r.runId);
      claims += score?.supportedClaims ?? 0;
      const attributed = score?.metadata?.parallelSupportedClaims;
      if (typeof attributed === 'number' && Number.isInteger(attributed) && attributed >= 0 && attributed <= (score?.supportedClaims ?? 0)) parallelClaims += attributed;
      else noAttribution++; 
    }
    const modelCostUsd = modelPrices
      ? (input * modelPrices.uncachedInputPerM +
          cr * modelPrices.cacheReadPerM +
          cw * modelPrices.cacheWritePerM +
          out * modelPrices.outputPerM) /
        1_000_000
      : null;
    return {
      runs: rs.length,
      runsWithoutLiability: noLiability,
      uncachedInputTokens: input,
      cacheReadTokens: cr,
      cacheWriteTokens: cw,
      outputTokens: out,
      contextTokens: input + cr + cw + out,
      parallelLiabilityMicro: micro,
      parallelLiabilityUsd: micro / 1_000_000,
      supportedClaimsTotal: claims,
      parallelSupportedClaims: parallelClaims,
      runsWithoutAttribution: noAttribution,
      claimsPerParallelDollar: micro > 0 && noLiability === 0 && noAttribution === 0 ? parallelClaims / (micro / 1_000_000) : null,
      modelCostUsd,
    };
  };
  return {
    E: per("E"),
    C: per("C"),
    notes: [
      "parallelLiability is a conservative reserved-liability amount (request-price accounting), not invoice-reconciled spend.",
      "claimsPerParallelDollar is null (N/A) for zero-spend arms: no artificial denominator is introduced; zero spend is shown directly.",
      "supportedClaimsTotal includes all services. claimsPerParallelDollar uses only explicitly Parallel-attributed claims and is unknown if any cost or attribution is missing.",
      "modelCostUsd is a token-price estimate distinct from Parallel charges; provider subscription estimates are not Parallel charges. Null means no prices were supplied: unknown, not zero.",
      "Unknown Context7 or other service charges remain unknown and do not debit the Parallel-only ceiling.",
      "runsWithoutLiability counts records with no liability field (gateway API pending): their liability is unknown and excluded from the sums, not treated as verified zero.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Outcome inventory: every attempted, incomplete, censored, and unattempted run
// ---------------------------------------------------------------------------

export interface InventoryRow {
  runId: string | null; // null for synthesized unattempted placeholders
  pairId: string;
  caseId: string;
  arm: Arm;
  status: RunStatus;
  scored: boolean;
  successful: boolean;
  note: string | null;
}

export interface OutcomeInventory {
  rows: InventoryRow[];
  countsByStatus: Record<string, number>;
  pairAnomalies: { pairId: string; anomalies: string[] }[];
  truncated: boolean; // expected pairs with at least one arm never attempted
  note: string;
}

export function outcomeInventory(
  runs: RunRecord[],
  scoreByRun: ReadonlyMap<string, RunScore>,
  expectedPairs?: string[],
): OutcomeInventory {
  const rows: InventoryRow[] = [];
  const counts: Record<string, number> = {};
  const bump = (s: string) => (counts[s] = (counts[s] ?? 0) + 1);
  for (const r of runs) {
    bump(r.status);
    const score = scoreByRun.get(r.runId);
    rows.push({
      runId: r.runId,
      pairId: r.pairId,
      caseId: r.caseId,
      arm: r.arm,
      status: r.status,
      scored: !!score,
      successful: isSuccessful(r, score),
      note:
        r.status === "harness_error"
          ? "verified harness transport fault: at most one replacement pair permitted; this attempt and its charges are retained"
          : r.status === "completed" && !score
            ? "missing score: explicit, never silently zero-filled in the main analysis"
            : null,
    });
  }
  const seen = new Map<string, Set<Arm>>();
  for (const r of runs) {
    if (!seen.has(r.pairId)) seen.set(r.pairId, new Set());
    seen.get(r.pairId)!.add(r.arm);
  }
  let truncated = false;
  if (expectedPairs) {
    for (const pairId of expectedPairs) {
      for (const arm of ["E", "C"] as const) {
        if (!seen.get(pairId)?.has(arm)) {
          truncated = true;
          bump("unattempted");
          rows.push({
            runId: null,
            pairId,
            caseId: pairId,
            arm,
            status: "unattempted",
            scored: false,
            successful: false,
            note: "unattempted pair remains visible; a truncated sample loses the planned superiority claim",
          });
        }
      }
    }
  }
  return {
    rows,
    countsByStatus: counts,
    pairAnomalies: pairRuns(runs)
      .filter((p) => p.anomalies.length)
      .map((p) => ({ pairId: p.pairId, anomalies: p.anomalies })),
    truncated,
    note: "Attempted pairs stay in the table: product errors, tool misuse, budget denials, and timeouts are outcomes, not reasons to rerun until success.",
  };
}

// ---------------------------------------------------------------------------
// Trigger timing (descriptive; rater-labeled opportunity events)
// ---------------------------------------------------------------------------

export interface TriggerLabel {
  runId: string;
  opportunityEventId: string | null; // null: no retrieval opportunity arose
  firstExternalDispatchEventId: string | null; // null: no valid dispatch (censored)
  firstParallelDispatchEventId?: string | null;
  parallelOpportunityEventId?: string | null; // null: no remaining gap requiring Parallel
}

export interface TriggerTimingRow {
  runId: string;
  opportunityEventId: string;
  externalLatencyMs: number | null; // null when censored
  externalCensored: boolean;
  externalCensoredAfterMs: number | null;
  parallelLatencyMs: number | null;
  parallelCensored: boolean;
  parallelApplicable: boolean;
}

export function triggerTimings(
  runs: RunRecord[],
  labels: TriggerLabel[],
): { rows: TriggerTimingRow[]; problems: string[] } {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const rows: TriggerTimingRow[] = [];
  const problems: string[] = [];
  const latency = (
    run: RunRecord,
    from: RunEvent,
    dispatchId: string | null | undefined,
  ): { ms: number | null; censored: boolean; censoredAfterMs: number | null } => {
    if (from.ts === undefined) {
      problems.push(`${run.runId}: opportunity event ${from.id} has no timestamp`);
      return { ms: null, censored: true, censoredAfterMs: null };
    }
    if (!dispatchId) {
      // No external retrieval yields a censored latency, not a zero-time success.
      return { ms: null, censored: true, censoredAfterMs: run.elapsedMs - from.ts };
    }
    const to = run.events.find((e) => e.id === dispatchId);
    if (!to) {
      problems.push(`${run.runId}: dispatch event ${dispatchId} not found`);
      return { ms: null, censored: true, censoredAfterMs: null };
    }
    if (to.ts === undefined) {
      problems.push(`${run.runId}: dispatch event ${dispatchId} has no timestamp`);
      return { ms: null, censored: true, censoredAfterMs: null };
    }
    return { ms: to.ts - from.ts, censored: false, censoredAfterMs: null };
  };
  for (const l of labels) {
    if (!l.opportunityEventId) continue;
    const run = byId.get(l.runId);
    if (!run) {
      problems.push(`${l.runId}: no such run`);
      continue;
    }
    const from = run.events.find((e) => e.id === l.opportunityEventId);
    if (!from) {
      problems.push(`${run.runId}: opportunity event ${l.opportunityEventId} not found`);
      continue;
    }
    const ext = latency(run, from, l.firstExternalDispatchEventId);
    const parallelFrom = l.parallelOpportunityEventId === null ? undefined : l.parallelOpportunityEventId ? run.events.find(e => e.id === l.parallelOpportunityEventId) : l.firstParallelDispatchEventId ? from : undefined;
    const par = parallelFrom ? latency(run, parallelFrom, l.firstParallelDispatchEventId ?? null) : {ms:null,censored:false};
    rows.push({
      runId: run.runId,
      opportunityEventId: from.id,
      externalLatencyMs: ext.ms,
      externalCensored: ext.censored,
      externalCensoredAfterMs: ext.censoredAfterMs,
      parallelLatencyMs: par.ms,
      parallelCensored: par.censored,
      parallelApplicable: !!parallelFrom,
    });
  }
  return { rows, problems };
}

// ---------------------------------------------------------------------------
// Claim decision (preregistered bounded-superiority conditions, plan §8)
// ---------------------------------------------------------------------------

export type ClaimDecision = "superior" | "mixed" | "worse" | "inconclusive";

export interface ClaimInput {
  primary: { meanDelta: number; ci: ConfidenceInterval };
  conservative: { meanDelta: number; ci: ConfidenceInterval };
  quality: { meanDelta: number; ci: ConfidenceInterval };
  eCriticalViolations: number;
  truncated: boolean;
  /**
   * Pairs excluded from the graded subset (missing runs or scores) plus
   * pending operator adjudications. Any unresolved exclusion blocks
   * superiority: the claim may not rest on the remaining graded subset.
   */
  unresolvedExclusions: number;
  /** True when the advantage does not survive every leave-one-family-out exclusion. */
  familySpecific: boolean;
}

export function decideClaim(input: ClaimInput): { decision: ClaimDecision; reasons: string[] } {
  const reasons: string[] = [];
  const favorable = isFavorable(input.primary);
  const unfavorable = input.primary.meanDelta <= -SUPERIORITY_MARGIN && input.primary.ci.hi < 0;
  if (unfavorable) {
    reasons.push(
      `primary mean delta ${input.primary.meanDelta} <= -${SUPERIORITY_MARGIN} with the 95% paired interval excluding zero in the unfavorable direction`,
    );
    return { decision: "worse", reasons };
  }
  if (!favorable) {
    reasons.push(
      `primary superiority thresholds not met (mean delta ${input.primary.meanDelta}, interval [${input.primary.ci.lo}, ${input.primary.ci.hi}]; required mean >= ${SUPERIORITY_MARGIN} with the interval excluding zero)`,
    );
    return { decision: "inconclusive", reasons };
  }
  if (input.truncated) {
    reasons.push("primary effect is favorable, but unattempted pairs truncated the sample; a truncated sample loses the planned superiority claim");
    return { decision: "inconclusive", reasons };
  }
  if (input.unresolvedExclusions > 0) {
    reasons.push(
      `primary effect is favorable on the graded subset, but ${input.unresolvedExclusions} exclusion(s) remain unresolved (missing runs, missing scores, or pending adjudications); superiority cannot be claimed on the remaining graded subset until every exclusion is resolved. Excluded pairs are listed explicitly and never zero-filled into the main analysis`,
    );
    return { decision: "inconclusive", reasons };
  }
  if (input.quality.ci.lo <= -QUALITY_NI_MARGIN) {
    reasons.push(
      `quality degradation beyond ${QUALITY_NI_MARGIN} points not ruled out (quality interval lower bound ${input.quality.ci.lo})`,
    );
  }
  if (input.eCriticalViolations > 0) {
    reasons.push(`${input.eCriticalViolations} extension-arm critical privacy/authorization violation(s)`);
  }
  if (!isFavorable(input.conservative)) {
    reasons.push("result is not favorable when incomplete runs receive conservative failure scores");
  }
  if (input.familySpecific) {
    reasons.push(
      "the advantage does not survive every leave-one-source-family-out exclusion; label the result family-specific, not generally superior",
    );
  }
  if (reasons.length > 0) return { decision: "mixed", reasons };
  reasons.push(
    "all preregistered conditions hold: primary improvement >= 0.25 with the interval excluding zero, quality noninferiority within 0.25, no extension-arm critical violations, conservative-score robustness, and no unresolved exclusions",
  );
  reasons.push(
    "scope caveat: the claim covers this fixed task mix with its recorded source-family clusters only; leave-one-family-out results accompany the report and the interval is not a population claim across unseen domains",
  );
  return { decision: "superior", reasons };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export const BLINDING_LIMITATION =
  "Raters receive neutral capability labels instead of product names where possible, but a scorer cannot be fully blind when output formats, CLI idioms, or unmapped tool names reveal the treatment. This report does not claim fully blind judging.";

export interface ReportInput {
  runs: RunRecord[];
  scores: RunScore[];
  caseStrata: Record<string, Stratum>; // required for every caseId present
  expectedPairs?: string[]; // manifest pair list; enables truncation detection
  modelPrices?: ModelPrices;
  triggerLabels?: TriggerLabel[];
  scoringSummary?: {
    agreementRate: number | null;
    /** Remaining unresolved queue items, not the historical disagreement count. */
    adjudicationCount: number;
    missingScoreCount: number;
    /** Overlays applied; does not imply rater agreement. */
    finalOverlayCount?: number;
  };
  opts?: EndpointOptions;
}

export interface BenchmarkReport {
  primary: EndpointResult & { strata: Record<Stratum, EndpointResult | null> };
  quality: EndpointResult & {
    noninferiorityMargin: number;
    qualityDegradationRuledOut: boolean;
  };
  conservativePrimary: EndpointResult;
  leaveOneFamilyOut: LofoResult[];
  familySpecific: boolean;
  time: RmstResult;
  efficiency: EfficiencyResult;
  costs: CostResult;
  outcomeInventory: OutcomeInventory;
  violations: {
    eCritical: number;
    cCritical: number;
    runs: { runId: string; arm: Arm; caseId: string }[];
  };
  excludedFromPaired: PairSelection["excluded"];
  claim: { decision: ClaimDecision; reasons: string[] };
  triggerTiming: { rows: TriggerTimingRow[]; problems: string[] } | null;
  scoringSummary: ReportInput["scoringSummary"] | null;
  notes: string[];
}

export function buildReport(input: ReportInput): BenchmarkReport {
  const opts = input.opts ?? {};
  const scoreByRun = new Map<string, RunScore>();
  for (const s of input.scores) if (!scoreByRun.has(s.runId)) scoreByRun.set(s.runId, s);
  const pairs = pairRuns(input.runs);
  const main = selectScoredPairs(pairs, scoreByRun, { conservative: false });
  const conservative = selectScoredPairs(pairs, scoreByRun, { conservative: true });
  if (main.scored.length === 0) throw new Error("no complete scored pairs; cannot build primary analysis");

  const primaryBase = analyzeEndpoint(main.scored, (s) => s.retrieval, opts);
  const strata = {} as Record<Stratum, EndpointResult | null>;
  for (const st of ["web", "no_web"] as const) {
    const sub = main.scored.filter((p) => input.caseStrata[p.pair.caseId] === st);
    strata[st] = sub.length ? analyzeEndpoint(sub, (s) => s.retrieval, opts) : null;
  }
  const qualityBase = analyzeEndpoint(main.scored, (s) => s.quality, opts);
  const conservativePrimary = analyzeEndpoint(conservative.scored, (s) => s.retrieval, opts);
  const lofo = leaveOneFamilyOut(main.scored, (s) => s.retrieval, opts);
  const familySpecific = isFavorable(primaryBase) && lofo.some((r) => !r.favorable);
  const time = restrictedMeanTime(pairs, scoreByRun, opts);
  const efficiency = tokenEfficiency(input.runs, scoreByRun, input.caseStrata);
  const costs = costTable(input.runs, scoreByRun, input.modelPrices);
  const inventory = outcomeInventory(input.runs, scoreByRun, input.expectedPairs);
  const violationRuns = input.runs
    .filter((r) => scoreByRun.get(r.runId)?.criticalViolation)
    .map((r) => ({ runId: r.runId, arm: r.arm, caseId: r.caseId }));
  const unresolvedExclusions = main.excluded.length + (input.scoringSummary?.adjudicationCount ?? 0);
  const claim = decideClaim({
    primary: primaryBase,
    conservative: conservativePrimary,
    quality: qualityBase,
    eCriticalViolations: violationRuns.filter((v) => v.arm === "E").length,
    truncated: inventory.truncated,
    unresolvedExclusions,
    familySpecific,
  });

  const notes = [
    "The bootstrap interval describes this fixed mixture of task blocks; it is not a population confidence claim across unseen domains. Raw paired deltas are included so another analysis can reproduce the comparison.",
    "The corpus repeats some underlying source facts across workflows; leave-one-source-family-out results accompany the primary estimate.",
    "Secondary metrics are descriptive; no selection of a favorable secondary metric replaces a failed primary result.",
    BLINDING_LIMITATION,
    "Parallel-specific trigger results are conditional diagnostics because each treatment can produce a different set of unresolved gaps.",
  ];
  if (familySpecific) {
    notes.push("The advantage does not survive every leave-one-family-out exclusion; label the result family-specific, not generally superior.");
  }
  if (inventory.truncated) {
    notes.push("Unattempted pairs remain visible in the outcome inventory; a truncated sample loses the planned superiority claim.");
  }
  if (main.excluded.length > 0) {
    notes.push(
      `${main.excluded.length} pair(s) are excluded from the graded subset (missing runs or scores) and listed in excludedFromPaired; they are never zero-filled into the main analysis, and superiority cannot be claimed until they are resolved`,
    );
  }

  return {
    primary: { ...primaryBase, strata },
    quality: {
      ...qualityBase,
      noninferiorityMargin: QUALITY_NI_MARGIN,
      qualityDegradationRuledOut: qualityBase.ci.lo > -QUALITY_NI_MARGIN,
    },
    conservativePrimary,
    leaveOneFamilyOut: lofo,
    familySpecific,
    time,
    efficiency,
    costs,
    outcomeInventory: inventory,
    violations: {
      eCritical: violationRuns.filter((v) => v.arm === "E").length,
      cCritical: violationRuns.filter((v) => v.arm === "C").length,
      runs: violationRuns,
    },
    excludedFromPaired: main.excluded,
    claim,
    triggerTiming: input.triggerLabels ? triggerTimings(input.runs, input.triggerLabels) : null,
    scoringSummary: input.scoringSummary ?? null,
    notes,
  };
}
