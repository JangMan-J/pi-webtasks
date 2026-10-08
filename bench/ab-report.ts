/**
 * Tier 0 WP0-4: paired statistics, variance, and Tier 1 sample sizing.
 * Bootstrap uses the round-1 convention: 10,000 resamples, seed 42017.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns, OUT } from './ab-metrics.ts';
import { scoreAll } from './ab-score.ts';

const SEED = 42017;
const RESAMPLES = 10000;

/** Deterministic PRNG so intervals reproduce exactly. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function sd(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - m) ** 2, 0) / (values.length - 1));
}

export function bootstrapCI(deltas: number[]): [number, number] {
  const next = rng(SEED);
  const means: number[] = [];
  for (let i = 0; i < RESAMPLES; i += 1) {
    let total = 0;
    for (let j = 0; j < deltas.length; j += 1) total += deltas[Math.floor(next() * deltas.length)];
    means.push(total / deltas.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * RESAMPLES)], means[Math.floor(0.975 * RESAMPLES)]];
}

/** Two-sided exact sign test, ties dropped. */
export function signTest(deltas: number[]): number {
  const positive = deltas.filter((delta) => delta > 0).length;
  const negative = deltas.filter((delta) => delta < 0).length;
  const n = positive + negative;
  if (!n) return 1;
  const k = Math.min(positive, negative);
  const choose = (a: number, b: number) => {
    let result = 1;
    for (let i = 0; i < b; i += 1) result = (result * (a - i)) / (i + 1);
    return result;
  };
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Pairs needed for a two-sided 95% interval to exclude zero at a given effect. */
export function pairsNeeded(effect: number, spread: number): number {
  return Math.ceil((1.96 * spread / Math.abs(effect)) ** 2);
}

if (process.argv[1] === import.meta.filename) {
  const rows = loadRuns('primary');
  const scores = scoreAll('primary');
  const byKey = new Map(rows.map((row) => [`${row.caseId}-${row.arm}`, row]));
  const scoreByKey = new Map(scores.map((row) => [`${row.caseId}-${row.arm}`, row]));
  const cases = [...new Set(rows.map((row) => row.caseId))].sort();

  const pairs = cases.map((caseId) => {
    const e = byKey.get(`${caseId}-E`)!;
    const c = byKey.get(`${caseId}-C`)!;
    const se = scoreByKey.get(`${caseId}-E`)!;
    const sc = scoreByKey.get(`${caseId}-C`)!;
    return {
      caseId,
      coverageDelta: (se.coverage ?? 0) - (sc.coverage ?? 0),
      recallDelta: (se.citationRecall ?? 0) - (sc.citationRecall ?? 0),
      contextDelta: e.contextTokens - c.contextTokens,
      logRatio: Math.log(e.contextTokens / c.contextTokens),
      secondsDelta: e.seconds - c.seconds,
      tokensPerClaimE: e.contextTokens / Math.max(se.coverage ?? 0, 0.01) / Math.max(se.decidable, 1),
      tokensPerClaimC: c.contextTokens / Math.max(sc.coverage ?? 0, 0.01) / Math.max(sc.decidable, 1),
    };
  });

  const metrics = [
    { id: 'claim coverage (E-C)', values: pairs.map((pair) => pair.coverageDelta) },
    { id: 'citation recall (E-C)', values: pairs.map((pair) => pair.recallDelta) },
    { id: 'context tokens (E-C)', values: pairs.map((pair) => pair.contextDelta) },
    { id: 'log token ratio', values: pairs.map((pair) => pair.logRatio) },
    { id: 'seconds (E-C)', values: pairs.map((pair) => pair.secondsDelta) },
  ].map((metric) => {
    const [low, high] = bootstrapCI(metric.values);
    return {
      id: metric.id,
      n: metric.values.length,
      mean: mean(metric.values),
      sd: sd(metric.values),
      ci: [low, high] as [number, number],
      signP: signTest(metric.values),
      excludesZero: low > 0 || high < 0,
    };
  });

  const coverageSd = sd([
    ...scores.filter((row) => row.coverage !== null).map((row) => row.coverage!),
  ]);
  const logRatioSd = sd(pairs.map((pair) => pair.logRatio));

  const sizing = {
    note: 'Tier 1 compares E@HEAD against E@HEAD+intervention. Round-1 cross-arm spread is a conservative prior for within-arm spread.',
    primary: [0.45, 0.6].map((reduction) => ({
      reduction,
      effectLogRatio: Math.log(1 - reduction),
      pairsNeeded: pairsNeeded(Math.log(1 - reduction), logRatioSd),
    })),
    nonInferiority: {
      margin: 0.1,
      coverageSd,
      pairsNeeded: pairsNeeded(0.1, coverageSd),
    },
  };

  const report = { generatedAt: new Date().toISOString(), pairs, metrics, sizing };
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('metric                      n     mean        sd      95% CI                    signP  excl0');
  for (const metric of metrics) {
    console.log(
      `${metric.id.padEnd(26)} ${metric.n}  ${metric.mean.toFixed(3).padStart(9)} ${metric.sd.toFixed(3).padStart(9)}  [${metric.ci[0].toFixed(3)}, ${metric.ci[1].toFixed(3)}]`.padEnd(88) +
        `${metric.signP.toFixed(4)}  ${metric.excludesZero ? 'yes' : 'no'}`,
    );
  }
  console.log(`\ncoverage SD ${coverageSd.toFixed(3)} | log token ratio SD ${logRatioSd.toFixed(3)}`);
  for (const entry of sizing.primary) {
    console.log(`Tier 1 primary: detect a ${(entry.reduction * 100).toFixed(0)}% token reduction -> ${entry.pairsNeeded} pairs`);
  }
  console.log(`Tier 1 guard: coverage non-inferiority at margin 0.10 -> ${sizing.nonInferiority.pairsNeeded} pairs`);
}
