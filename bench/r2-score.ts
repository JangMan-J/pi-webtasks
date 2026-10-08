/**
 * Round 2 deterministic scoring of the structured JSON tail against the
 * preregistered verdicts in bench/gold-round2.json (RIDDLER-FORMAT-B).
 *
 * Per field: pass, fail, or judge. Following the author's rules:
 * - null means uncertainty -> judge (prose may carry the fact);
 * - an unrecognized string paraphrase -> judge, never automatic failure;
 * - booleans and Q4's exact set are decided mechanically;
 * - correct JSON never overrides contradictory prose, so a deterministic
 *   pass is provisional until the judges clear the prose.
 * Route attribution is recomputed from raw events with the current classifier
 * so runs recorded before the classifier fix are counted identically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './core.ts';
import { routeAttribution } from './r2-run.ts';

export type Verdict = 'pass' | 'fail' | 'judge';

const norm = (value: unknown) => String(value).toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();

export function checkField(spec: any, value: unknown, equivalents: Record<string, string[]>): Verdict {
  if (value === undefined || value === null) return 'judge';
  if (typeof spec === 'boolean') return value === spec ? 'pass' : typeof value === 'boolean' ? 'fail' : 'judge';
  if (spec.equivalent) {
    const text = norm(value);
    return (equivalents[spec.equivalent] ?? []).some((form) => text.includes(norm(form))) ? 'pass' : 'judge';
  }
  if (spec.exact) return norm(value) === norm(spec.exact) ? 'pass' : 'judge';
  if (!Array.isArray(value)) return 'judge';
  const members = value.map(norm);
  if (spec.exact_set) {
    const want = new Set<string>(spec.exact_set.map(norm));
    const got = new Set(members);
    return got.size === want.size && [...want].every((item) => got.has(item)) ? 'pass' : 'fail';
  }
  if (spec.any_of) return spec.any_of.some((item: string) => members.some((member) => member.includes(norm(item)))) ? 'pass' : 'judge';
  if (spec.must_include) return spec.must_include.every((item: string) => members.some((member) => member.includes(norm(item)))) ? 'pass' : 'fail';
  return 'judge';
}

/**
 * The wrapper renders required fields as `name:S`, and a worker can copy the
 * type suffix into its key (`token_limit_relationship:S`). The intended field
 * is unambiguous, so read it with the suffix stripped and record the lapse as
 * a format-compliance note rather than a correctness failure.
 */
function normalizeFacts(facts: any): { facts: any; suffixedKeys: boolean } {
  if (!facts || typeof facts !== 'object') return { facts, suffixedKeys: false };
  let suffixedKeys = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    const bare = key.replace(/:[SBA]$/, '');
    if (bare !== key) suffixedKeys = true;
    out[bare] = value;
  }
  return { facts: out, suffixedKeys };
}

export function scoreRun(gold: any, run: any) {
  const entry = gold.cases[run.caseId];
  const raw = run.jsonTail;
  const normalized = normalizeFacts(raw?.facts);
  const tail = raw ? { ...raw, facts: normalized.facts } : raw;
  const format = {
    present: !!raw,
    questionIdMatches: raw?.question_id === run.caseId,
    allFactsKeys: !!raw?.facts && Object.keys(entry.facts_fields).every((key) => key in raw.facts),
    suffixedKeys: normalized.suffixedKeys,
  };
  const fields = Object.fromEntries(
    Object.entries(entry.deterministic).map(([key, spec]) => [key, tail?.facts ? checkField(spec, tail.facts[key], gold.grading.equivalents) : 'judge']),
  ) as Record<string, Verdict>;
  const verdicts = Object.values(fields);
  const overall: Verdict = !tail ? 'judge' : verdicts.includes('fail') ? 'fail' : verdicts.every((verdict) => verdict === 'pass') ? 'pass' : 'judge';
  const claimed = (tail?.sources ?? []).filter((source: any) => source?.retrieved_this_run === true).length;
  return {
    caseId: run.caseId,
    arm: run.arm,
    status: run.status,
    format,
    fields,
    overall,
    selfReport: { sourcesClaimedRetrieved: claimed, executedThisRun: tail?.execution?.executed_this_run ?? null },
    route: routeAttribution(run.events),
    minutes: run.elapsedMs / 60000,
    context: run.usage.input + run.usage.cacheRead + run.usage.cacheWrite,
    reasoning: run.usage.reasoning,
    usd: run.parallelLiabilityMicro / 1e6,
  };
}

/** The scored pair for each case: the latest attempt directory that exists. */
export function loadRound2() {
  const data = path.join(ROOT, '.pi/benchmark/data');
  const gold = readJSON(path.join(ROOT, 'bench/gold-round2.json'));
  const rows: any[] = [];
  for (const id of Object.keys(gold.cases)) {
    const dirs = fs.readdirSync(data).filter((name) => name === `r2-${id}` || name.startsWith(`r2-${id}-a`)).sort();
    const dir = dirs.at(-1);
    if (!dir) continue;
    for (const arm of ['E', 'C']) {
      const file = path.join(data, dir, arm, 'run.json');
      if (fs.existsSync(file)) rows.push({ pairDir: dir, ...scoreRun(gold, readJSON(file)) });
    }
  }
  return { gold, rows };
}

if (process.argv[1] === import.meta.filename) {
  const { rows } = loadRound2();
  fs.writeFileSync(path.join(ROOT, '.pi/benchmark/data/r2-deterministic.json'), JSON.stringify(rows, null, 2));
  const mark = (verdict: Verdict) => (verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '?');
  console.log('case arm status     fields     overall  gw cli c7 direct  min   ctx(K)  $');
  for (const row of rows) {
    const r = row.route;
    console.log(
      `${row.caseId.padEnd(4)} ${row.arm}   ${row.status.padEnd(10)} ${Object.values(row.fields as Record<string, Verdict>).map(mark).join('').padEnd(10)} ${row.overall.padEnd(7)} ${String(r.interfaceDispatches).padStart(3)} ${String(r.cliInterfaceCalls).padStart(3)} ${String(r.context7Calls).padStart(2)} ${String(r.directHttpCalls).padStart(6)}  ${row.minutes.toFixed(1).padStart(4)} ${(row.context / 1000).toFixed(0).padStart(7)}  ${row.usd.toFixed(3)}`,
    );
  }
  const fields = rows.flatMap((row) => Object.values(row.fields as Record<string, Verdict>));
  const count = (verdict: Verdict) => fields.filter((value) => value === verdict).length;
  console.log(`\nfield verdicts: ${count('pass')} pass, ${count('fail')} fail, ${count('judge')} judge of ${fields.length} (${((100 * (count('pass') + count('fail'))) / fields.length).toFixed(0)}% decided mechanically)`);
}
