/**
 * Round 2 report: all five dimensions per run, paired E vs C per case.
 *
 * Scored pair per case is the latest attempt; superseded attempts are listed
 * with their reasons. Rater scores are reported per rater, never averaged.
 * Retrieval verification cross-checks each self-reported retrieved source
 * against the transcript: trace-supported or unverified. Absence of a match is
 * never reported as fabrication, because the matcher can miss equivalent URLs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, saveJSON, sha } from './core.ts';
import { scoreRun } from './r2-score.ts';
import { scoredRuns, RATERS } from './r2-grade.ts';
import { shellRoute } from './r2-run.ts';
import { mean, sd, bootstrapCI, signTest } from './ab-report.ts';

const DATA = path.join(ROOT, '.pi/benchmark/data');

/** Everything the agent requested or received: tool arguments, tool outputs, gateway bodies. */
function transcriptHaystack(run: any): string {
  const parts: string[] = [];
  const last = run.events.filter((event: any) => event.type === 'provider_request').at(-1)?.payload;
  for (const item of last?.input ?? []) {
    if (item.type === 'function_call') parts.push(String(item.arguments ?? ''));
    if (item.type === 'function_call_output') parts.push(String(item.output ?? ''));
  }
  for (const event of run.events) {
    if (event.type === 'tool_call') parts.push(JSON.stringify(event.input ?? {}));
    if (event.type === 'gateway_request') parts.push(JSON.stringify(event.body ?? {}));
  }
  return parts.join('\n').toLowerCase();
}

/** Tokens that identify the same document across GitHub, raw, API, unpkg, npm, and docs URL forms. */
export function documentKeys(url: string): string[][] {
  const bare = url.toLowerCase().replace(/^https?:\/\//, '').replace(/#.*$/, '').replace(/\/+$/, '');
  const [host, ...segments] = bare.split('/');
  if (host === 'github.com' && segments.length >= 2) {
    const repo = `${segments[0]}/${segments[1]}`;
    const rest = segments.slice(2);
    if ((rest[0] === 'blob' || rest[0] === 'tree' || rest[0] === 'raw') && rest.length >= 3) return [[repo, rest.slice(2).join('/')]];
    return [[repo, rest.at(-1) ?? repo]];
  }
  if (host === 'raw.githubusercontent.com' && segments.length >= 4) return [[`${segments[0]}/${segments[1]}`, segments.slice(3).join('/')]];
  if (host === 'api.github.com' && segments[0] === 'repos' && segments.length >= 3) return [[`${segments[1]}/${segments[2]}`, segments.slice(3).join('/') || segments[2]]];
  if (host === 'unpkg.com') return [[segments.slice(0, segments[0].startsWith('@') ? 2 : 1).join('/').replace(/@[^/]*$/, ''), segments.at(-1) ?? '']];
  if (host === 'registry.npmjs.org') return [[segments.slice(0, segments[0]?.startsWith('@') ? 2 : 1).join('/'), 'registry.npmjs.org']];
  return [[bare], [host, segments.slice(-2).join('/')]];
}

export function retrievalVerification(run: any) {
  const claimed = (run.jsonTail?.sources ?? []).filter((source: any) => source?.retrieved_this_run === true && typeof source.url === 'string');
  if (!claimed.length) return { claimed: 0, traceSupported: 0, unverified: [] as string[] };
  const haystack = transcriptHaystack(run);
  const unverified: string[] = [];
  let supported = 0;
  for (const source of claimed) {
    const matched = documentKeys(source.url).some((keys) => keys.every((key) => key && haystack.includes(key)));
    if (matched) supported += 1; else unverified.push(source.url);
  }
  return { claimed: claimed.length, traceSupported: supported, unverified };
}

const INTERPRETER = /\b(python3?|node|pytest|cargo|go run|jsonschema|check-jsonschema)\b/;
export function executionVerification(run: any) {
  const claimed = run.jsonTail?.execution?.executed_this_run === true;
  const checks = run.jsonTail?.execution?.checks ?? [];
  const executed = run.events.filter((event: any) => event.type === 'tool_call' && event.tool === 'bash')
    .map((event: any) => String(event.input?.command ?? ''))
    .filter((command: string) => shellRoute(command) === 'other' && INTERPRETER.test(command));
  return { claimed, claimedChecks: checks.length, interpreterRunsInTrace: executed.length, status: claimed ? (executed.length ? 'trace-supported' : 'unverified') : 'not-claimed' };
}

function raterScores(run: any) {
  const mapping = readJSON(path.join(DATA, 'grading/r2/mapping.json'));
  const graderId = Object.entries(mapping).find(([, runId]) => runId === run.runId)?.[0];
  return Object.fromEntries(RATERS.map((rater) => {
    const file = graderId ? path.join(DATA, 'grading/r2', `${graderId}.${rater.name}.json`) : '';
    return [rater.name, file && fs.existsSync(file) ? readJSON(file).score : null];
  }));
}

if (process.argv[1] === import.meta.filename) {
  const { gold, runs } = scoredRuns();
  const rows = runs.map((run) => {
    const det = scoreRun(gold, run);
    const raters = raterScores(run);
    const correctFor = (name: string) => run.status === 'completed' && det.overall !== 'fail' && raters[name]?.answer_correctness === 'correct';
    return {
      caseId: run.caseId, arm: run.arm, status: run.status,
      deterministic: det.overall, fields: det.fields, format: det.format,
      correct: Object.fromEntries(RATERS.map((rater) => [rater.name, correctFor(rater.name)])),
      support: Object.fromEntries(RATERS.map((rater) => [rater.name, raters[rater.name]?.source_support ?? null])),
      route: det.route,
      retrieval: retrievalVerification(run),
      execution: executionVerification(run),
      minutes: det.minutes, context: det.context, reasoning: det.reasoning, usd: det.usd,
    };
  });

  const cases = [...new Set(rows.map((row) => row.caseId))].sort();
  const pair = (id: string) => ({ E: rows.find((row) => row.caseId === id && row.arm === 'E')!, C: rows.find((row) => row.caseId === id && row.arm === 'C')! });
  const complete = cases.filter((id) => pair(id).E && pair(id).C);

  const discordance = Object.fromEntries(RATERS.map((rater) => {
    const deltas = complete.map((id) => Number(pair(id).E.correct[rater.name]) - Number(pair(id).C.correct[rater.name]));
    return [rater.name, { eOnly: deltas.filter((d) => d > 0).length, cOnly: deltas.filter((d) => d < 0).length, ties: deltas.filter((d) => d === 0).length, signP: signTest(deltas) }];
  }));

  const efficiency = (pick: (row: any) => number, label: string) => {
    const logs = complete.map((id) => Math.log(pick(pair(id).E) / pick(pair(id).C)));
    const [low, high] = bootstrapCI(logs);
    return { metric: label, pairs: logs.length, eLower: logs.filter((value) => value < 0).length, cLower: logs.filter((value) => value > 0).length, meanRatio: Math.exp(mean(logs)), ci: [Math.exp(low), Math.exp(high)], sdLog: sd(logs), signP: signTest(logs) };
  };
  const interfaceSubset = complete.filter((id) => pair(id).E.route.interfaceDispatches > 0 || pair(id).C.route.interfaceDispatches > 0);

  const superseded = fs.readdirSync(path.join(DATA, 'r2-superseded')).concat(
    fs.readdirSync(DATA).filter((name) => /^r2-Q[1-8]$/.test(name) && fs.readdirSync(DATA).some((other) => other.startsWith(`${name}-a`))).map((name) => `${name} (replaced by a later attempt)`),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    goldHash: sha(fs.readFileSync(path.join(ROOT, 'bench/gold-round2.json'))),
    completePairs: complete.length,
    rows,
    discordance,
    efficiency: [efficiency((row) => row.context, 'context tokens'), efficiency((row) => row.minutes, 'wall minutes'), efficiency((row) => Math.max(row.usd, 0.0005), 'parallel usd')],
    interfaceSubset: { cases: interfaceSubset, note: 'Interface use is itself affected by arm; not an unbiased estimate of a pure interface effect.' },
    superseded,
  };
  saveJSON(path.join(DATA, 'r2-report.json'), report);

  console.log('case arm status     det   muse fugu  support(m/f)          gw cli c7 dir  retr(sup/claim) exec          min  ctxK  $');
  for (const row of rows) {
    console.log(`${row.caseId.padEnd(4)} ${row.arm}   ${row.status.padEnd(10)} ${row.deterministic.padEnd(5)} ${row.correct.muse ? ' ✓  ' : ' ✗  '} ${row.correct.fugu ? ' ✓  ' : ' ✗  '} ${`${row.support.muse}/${row.support.fugu}`.padEnd(21)} ${String(row.route.interfaceDispatches).padStart(2)} ${String(row.route.cliInterfaceCalls).padStart(3)} ${String(row.route.context7Calls).padStart(2)} ${String(row.route.directHttpCalls).padStart(3)}  ${`${row.retrieval.traceSupported}/${row.retrieval.claimed}`.padStart(8)}        ${row.execution.status.padEnd(13)} ${row.minutes.toFixed(1).padStart(4)} ${(row.context / 1000).toFixed(0).padStart(5)}  ${row.usd.toFixed(3)}`);
  }
  console.log('\ncorrectness discordance per rater:', JSON.stringify(discordance));
  for (const entry of report.efficiency) console.log(`${entry.metric.padEnd(15)} E lower ${entry.eLower}, C lower ${entry.cLower}; geometric-mean E/C ${entry.meanRatio.toFixed(2)} (95% CI ${entry.ci[0].toFixed(2)}-${entry.ci[1].toFixed(2)}); sign p ${entry.signP.toFixed(3)}`);
  console.log('interface-use subset:', interfaceSubset.join(','));
  const retrieval = rows.reduce((totals, row) => ({ claimed: totals.claimed + row.retrieval.claimed, supported: totals.supported + row.retrieval.traceSupported }), { claimed: 0, supported: 0 });
  console.log(`retrieval self-reports: ${retrieval.supported}/${retrieval.claimed} trace-supported`);
  console.log('superseded:', superseded.join('; '));
}
