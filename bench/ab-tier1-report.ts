/**
 * Tier 1 analysis: baseline versus lazy tool exposure, paired by case.
 * Primary endpoint is total context tokens per run, which absorbs any extra
 * turns the activation costs. Guard endpoint is objective claim coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { attribute, DATA, OUT } from './ab-metrics.ts';
import { scoreRun } from './ab-score.ts';
import { mean, sd, bootstrapCI, signTest, pairsNeeded } from './ab-report.ts';
import { artifactNavigation } from './reach.ts';

const CONDITIONS = ['baseline', 'lazy'] as const;

/** Keep pairing intact: either side navigating an artifact puts the pair in that stratum. */
export function artifactStrata(pairs: any[]) {
  return Object.fromEntries([
    ['all', pairs],
    ['artifactNavigation', pairs.filter(p => p.baseline.artifactNavigation || p.lazy.artifactNavigation)],
    ['withoutArtifactNavigation', pairs.filter(p => !p.baseline.artifactNavigation && !p.lazy.artifactNavigation)],
  ].map(([name, group]: any) => {
    const ratios = group.map((p: any) => Math.log(p.lazy.context / p.baseline.context));
    return [name, { n: group.length, meanLogContextRatio: group.length ? mean(ratios) : null,
      logRatioCI: group.length ? bootstrapCI(ratios) : null,
      baselineContext: group.reduce((n: number, p: any) => n + p.baseline.context, 0),
      lazyContext: group.reduce((n: number, p: any) => n + p.lazy.context, 0) }];
  }));
}

export function activationDetails(events: any[]) {
  return events.flatMap((e, index) => {
    if (e.type !== 'tool_call' || e.tool !== 'parallel_tools') return [];
    const result = events.find(r => r.type === 'tool_execution_end' && r.tool_call_id === e.tool_call_id);
    let activated: unknown = null;
    try { activated = JSON.parse(result?.output?.find((p: any) => p.type === 'text')?.text ?? '{}').activated ?? null; } catch { /* Historical result without a JSON receipt. */ }
    const follow = events.slice(index + 1).find(r => r.type === 'tool_call' && /^parallel_(task|group|findall|monitor|memory|account)$/.test(r.tool));
    return [{ requested: e.input?.tools ?? null, activated, requestIndex: e.requests ?? null,
      nextDeferredTool: follow?.tool ?? null, nextDeferredInput: follow?.input ?? null }];
  });
}

export function loadTier1() {
  const gold = JSON.parse(fs.readFileSync('bench/gold.json', 'utf8'));
  const pairs: any[] = [];
  for (const dir of fs.readdirSync(DATA).filter((name) => name.startsWith('tier1-')).sort()) {
    const caseId = dir.replace('tier1-', '');
    const entry: any = { caseId };
    for (const condition of CONDITIONS) {
      const file = path.join(DATA, dir, condition, 'run.json');
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      const usage = run.usage ?? {};
      const requests = run.events.filter((event: any) => event.type === 'provider_request').length;
      const attribution = attribute(run.events);
      const score = scoreRun(gold, caseId, run);
      entry[condition] = {
        status: run.status,
        context: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
        output: usage.output ?? 0,
        requests,
        seconds: run.elapsedMs / 1000,
        toolCalls: run.events.filter((event: any) => event.type === 'tool_call').length,
        dispatches: run.events.filter((event: any) => event.type === 'gateway_request').length,
        activationCalls: run.activationCalls ?? 0,
        activationDetails: activationDetails(run.events),
        artifactNavigation: artifactNavigation(run.events.filter((e: any) => e.type === 'tool_call').map((e: any, index: number) => ({ name: e.tool, args: e.input, index }))),
        liabilityUsd: (run.parallelLiabilityMicro ?? 0) / 1e6,
        schemaCharsPerRequest: requests ? attribution.toolSchemaChars / requests : 0,
        coverage: score.coverage,
        citationRecall: score.citationRecall,
      };
    }
    if (entry.baseline && entry.lazy) pairs.push(entry);
  }
  return pairs;
}

if (process.argv[1] === import.meta.filename) {
  const pairs = loadTier1();
  const metric = (pick: (side: any) => number) => pairs.map((pair) => pick(pair.lazy) - pick(pair.baseline));

  const logRatio = pairs.map((pair) => Math.log(pair.lazy.context / pair.baseline.context));
  const coverageDelta = pairs.map((pair) => (pair.lazy.coverage ?? 0) - (pair.baseline.coverage ?? 0));

  const rows = [
    { id: 'log context ratio (lazy/base)', values: logRatio },
    { id: 'context tokens (lazy-base)', values: metric((side) => side.context) },
    { id: 'claim coverage (lazy-base)', values: coverageDelta },
    { id: 'requests (lazy-base)', values: metric((side) => side.requests) },
    { id: 'seconds (lazy-base)', values: metric((side) => side.seconds) },
    { id: 'schema chars/request delta', values: metric((side) => side.schemaCharsPerRequest) },
  ].map((row) => {
    const [low, high] = bootstrapCI(row.values);
    return { ...row, n: row.values.length, mean: mean(row.values), sd: sd(row.values), ci: [low, high] as [number, number], signP: signTest(row.values), excludesZero: low > 0 || high < 0 };
  });

  const totals = Object.fromEntries(
    CONDITIONS.map((condition) => [
      condition,
      {
        context: pairs.reduce((total, pair) => total + pair[condition].context, 0),
        requests: pairs.reduce((total, pair) => total + pair[condition].requests, 0),
        seconds: pairs.reduce((total, pair) => total + pair[condition].seconds, 0),
        liabilityUsd: pairs.reduce((total, pair) => total + pair[condition].liabilityUsd, 0),
        coverage: mean(pairs.map((pair) => pair[condition].coverage ?? 0)),
        activationCalls: pairs.reduce((total, pair) => total + pair[condition].activationCalls, 0),
      },
    ]),
  );

  const report = { generatedAt: new Date().toISOString(), pairs, rows, totals, strata: artifactStrata(pairs), guard: { margin: 0.1, sd: sd(coverageDelta), detectable: 1.96 * sd(coverageDelta) / Math.sqrt(pairs.length), pairsForMargin: pairsNeeded(0.1, sd(coverageDelta)) } };
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, 'tier1-report.json'), JSON.stringify(report, null, 2));

  console.log('case  base_ctx  lazy_ctx  ratio  base_req lazy_req  base_cov lazy_cov  act');
  for (const pair of pairs) {
    console.log(
      `${pair.caseId.padEnd(5)} ${String(pair.baseline.context).padStart(8)} ${String(pair.lazy.context).padStart(9)}  ${(pair.lazy.context / pair.baseline.context).toFixed(2)}   ${String(pair.baseline.requests).padStart(6)} ${String(pair.lazy.requests).padStart(8)}   ${(pair.baseline.coverage ?? 0).toFixed(2)}     ${(pair.lazy.coverage ?? 0).toFixed(2)}   ${pair.lazy.activationCalls}`,
    );
  }
  console.log('\nmetric                          n     mean         sd     95% CI                        signP  excl0');
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(30)} ${row.n} ${row.mean.toFixed(3).padStart(10)} ${row.sd.toFixed(3).padStart(10)}  [${row.ci[0].toFixed(3)}, ${row.ci[1].toFixed(3)}]`.padEnd(95) +
        `${row.signP.toFixed(4)}  ${row.excludesZero ? 'yes' : 'no'}`,
    );
  }
  console.log(`\ntotals  baseline context ${totals.baseline.context} / lazy ${totals.lazy.context} (${((1 - totals.lazy.context / totals.baseline.context) * 100).toFixed(1)}% lower)`);
  console.log(`        coverage ${totals.baseline.coverage.toFixed(3)} -> ${totals.lazy.coverage.toFixed(3)} | spend $${totals.baseline.liabilityUsd.toFixed(3)} / $${totals.lazy.liabilityUsd.toFixed(3)} | activation calls ${totals.lazy.activationCalls}`);
  console.log(`artifact strata ${JSON.stringify(report.strata)}`);
  console.log(`guard   coverage delta SD ${report.guard.sd.toFixed(3)}; at n=${pairs.length} only a regression >= ${report.guard.detectable.toFixed(3)} is detectable (0.10 margin would need ${report.guard.pairsForMargin} pairs)`);
}
