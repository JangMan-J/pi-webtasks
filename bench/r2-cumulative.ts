/**
 * Decompose cumulative processed tokens into what was actually resent.
 *
 * Every provider request carries the fixed prefix (instructions + tool
 * schemas) and the whole transcript so far. Summing each component across all
 * requests shows where cumulative processing comes from. Characters are
 * converted to tokens with each run's own ratio of reported tokens to payload
 * characters, so components sum to the run's cumulative total.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './core.ts';
import { shellRoute } from './r2-run.ts';

const DATA = path.join(ROOT, '.pi/benchmark/data');
export const PAIRS = ['r2-Q1', 'r2-Q2', 'r2-Q3', 'r2-Q4', 'r2-Q5-a2', 'r2-Q6', 'r2-Q7-a2', 'r2-Q8'];

type Component = 'instructions' | 'tool_schemas' | 'prompt' | 'reasoning' | 'tool_calls' | 'out_resource' | 'out_context7' | 'out_direct' | 'out_read_file' | 'out_skill' | 'out_shell_other' | 'out_harness';

/** Where a tool result's bytes came from. Reads of fetched files count as reads, since the fetch itself is small. */
function outputClass(name: string, args: any): Component {
  if (name.startsWith('parallel_')) return 'out_resource';
  if (name === 'read') {
    const file = String(args?.path ?? '');
    if (file.startsWith('/opt/resources/')) return 'out_skill';
    if (file.startsWith('/work/events')) return 'out_harness';
    return 'out_read_file';
  }
  if (name === 'bash') {
    const route = shellRoute(String(args?.command ?? ''));
    return route === 'cli' ? 'out_resource' : route === 'context7' ? 'out_context7' : route === 'direct' ? 'out_direct' : 'out_shell_other';
  }
  return 'out_shell_other';
}

export function decompose(run: any, stdout: any[]) {
  const chars: Record<string, number> = {};
  const add = (key: Component, value: number) => { chars[key] = (chars[key] ?? 0) + value; };
  const requests = run.events.filter((event: any) => event.type === 'provider_request');
  for (const request of requests) {
    const payload = request.payload ?? {};
    add('instructions', String(payload.instructions ?? '').length);
    add('tool_schemas', JSON.stringify(payload.tools ?? []).length);
    const calls = new Map<string, { name: string; args: any }>();
    for (const item of payload.input ?? []) {
      if (item.type === 'function_call') {
        let args: any = {};
        try { args = JSON.parse(item.arguments ?? '{}'); } catch { /* keep empty */ }
        calls.set(item.call_id, { name: item.name, args });
      }
    }
    for (const item of payload.input ?? []) {
      const size = JSON.stringify(item).length;
      if (item.type === 'function_call') add('tool_calls', size);
      else if (item.type === 'function_call_output') { const call = calls.get(item.call_id); add(call ? outputClass(call.name, call.args) : 'out_shell_other', size); }
      else if (item.type === 'reasoning') add('reasoning', size);
      else add('prompt', size);
    }
  }
  const usage = stdout.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').map((event) => event.message.usage ?? {});
  const perRequest = usage.map((u: any) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
  const cumulative = perRequest.reduce((a: number, b: number) => a + b, 0);
  const totalChars = Object.values(chars).reduce((a, b) => a + b, 0);
  const perToken = totalChars / cumulative;
  const tokens = Object.fromEntries(Object.entries(chars).map(([key, value]) => [key, Math.round(value / perToken)]));
  return { requests: requests.length, cumulative, peak: Math.max(...perRequest), first: perRequest[0] ?? 0, cacheRead: usage.reduce((a: number, u: any) => a + (u.cacheRead ?? 0), 0), tokens, charsPerToken: perToken };
}

if (process.argv[1] === import.meta.filename) {
  const order: Component[] = ['instructions', 'tool_schemas', 'prompt', 'reasoning', 'tool_calls', 'out_resource', 'out_context7', 'out_direct', 'out_read_file', 'out_skill', 'out_shell_other', 'out_harness'];
  const totals: Record<string, Record<string, number>> = { E: {}, C: {} };
  const rows: any[] = [];
  for (const dir of PAIRS) for (const arm of ['E', 'C']) {
    const base = path.join(DATA, dir, arm);
    const run = JSON.parse(fs.readFileSync(path.join(base, 'run.json'), 'utf8'));
    const stdout = fs.readFileSync(path.join(base, 'stdout.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const d = decompose(run, stdout);
    rows.push({ caseId: run.caseId, arm, ...d });
    for (const key of order) totals[arm][key] = (totals[arm][key] ?? 0) + (d.tokens[key] ?? 0);
    totals[arm].cumulative = (totals[arm].cumulative ?? 0) + d.cumulative;
    totals[arm].requests = (totals[arm].requests ?? 0) + d.requests;
  }
  fs.writeFileSync(path.join(DATA, 'r2-cumulative.json'), JSON.stringify({ rows, totals }, null, 2));
  const k = (value: number) => `${(value / 1000).toFixed(0)}K`.padStart(7);
  console.log('component          E         C     (share E / C)');
  for (const key of order) console.log(`${key.padEnd(16)} ${k(totals.E[key])} ${k(totals.C[key])}   ${(100 * totals.E[key] / totals.E.cumulative).toFixed(0).padStart(3)}% / ${(100 * totals.C[key] / totals.C.cumulative).toFixed(0).padStart(3)}%`);
  console.log(`${'TOTAL'.padEnd(16)} ${k(totals.E.cumulative)} ${k(totals.C.cumulative)}   requests ${totals.E.requests} / ${totals.C.requests}`);
  console.log('\nper run: case arm requests first peak cumulative | largest component');
  for (const row of rows) {
    const top = Object.entries(row.tokens as Record<string, number>).sort((a, b) => b[1] - a[1])[0];
    console.log(`${row.caseId} ${row.arm} ${String(row.requests).padStart(3)} ${k(row.first)} ${k(row.peak)} ${k(row.cumulative)} | ${top[0]} ${k(top[1])}`);
  }
}
