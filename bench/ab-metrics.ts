/**
 * Tier 0 WP0-1: per-run metrics and exact context attribution over the
 * preserved round-1 corpus. Reads only; writes to .pi/benchmark/data/tier0/.
 *
 * Attribution is exact rather than estimated because every provider_request
 * event retains its full payload: the system prompt, the serialized tool
 * schemas, and every tool result message. Context is charged per request, so
 * a component's cost is its byte size summed over the requests that carried it.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA = '.pi/benchmark/data';
export const OUT = '.pi/benchmark/data/tier0';

export interface Attribution {
  systemChars: number;
  toolSchemaChars: number;
  userChars: number;
  assistantChars: number;
  toolResultChars: number;
  byTool: Record<string, number>;
  totalChars: number;
}

export interface RunRow {
  caseId: string;
  arm: string;
  status: string;
  requests: number;
  toolCalls: number;
  dispatches: number;
  liabilityUsd: number;
  seconds: number;
  answerChars: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  contextTokens: number;
  totalTokens: number;
  attribution: Attribution;
  toolSchemaCharsPerRequest: number;
  systemCharsPerRequest: number;
}

const empty = (): Attribution => ({
  systemChars: 0,
  toolSchemaChars: 0,
  userChars: 0,
  assistantChars: 0,
  toolResultChars: 0,
  byTool: {},
  totalChars: 0,
});

/** Serialized size of one message content, as sent to the provider. */
function size(value: unknown): number {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
}

/**
 * Attribute every byte of every request payload to a component. Tool results
 * are keyed by the tool that produced them, resolved through the assistant
 * tool_calls that precede them in the same payload.
 */
export function attribute(events: any[]): Attribution {
  const totals = empty();
  for (const event of events) {
    if (event.type !== 'provider_request') continue;
    const payload = event.payload ?? {};
    const names = new Map<string, string>();
    for (const message of payload.messages ?? []) {
      for (const call of message.tool_calls ?? []) {
        const id = call.id ?? call.tool_call_id;
        const name = call.function?.name ?? call.name;
        if (id && name) names.set(id, name);
      }
    }
    totals.toolSchemaChars += JSON.stringify(payload.tools ?? []).length;
    for (const message of payload.messages ?? []) {
      const bytes = size(message.content);
      if (message.role === 'system') totals.systemChars += bytes;
      else if (message.role === 'user') totals.userChars += bytes;
      else if (message.role === 'tool') {
        totals.toolResultChars += bytes;
        const name = names.get(message.tool_call_id) ?? 'unknown';
        totals.byTool[name] = (totals.byTool[name] ?? 0) + bytes;
      } else {
        totals.assistantChars += bytes + JSON.stringify(message.tool_calls ?? []).length;
      }
    }
  }
  totals.totalChars =
    totals.systemChars + totals.toolSchemaChars + totals.userChars + totals.assistantChars + totals.toolResultChars;
  return totals;
}

export function loadRuns(phase = 'primary'): RunRow[] {
  const rows: RunRow[] = [];
  for (const dir of fs.readdirSync(DATA).filter((name) => name.startsWith(`${phase}-`)).sort()) {
    for (const arm of ['E', 'C']) {
      const file = path.join(DATA, dir, arm, 'run.json');
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      const usage = run.usage ?? {};
      const events: any[] = run.events ?? [];
      const requests = events.filter((event) => event.type === 'provider_request').length;
      const attribution = attribute(events);
      rows.push({
        caseId: run.caseId,
        arm: run.arm,
        status: run.status,
        requests,
        toolCalls: events.filter((event) => event.type === 'tool_call').length,
        dispatches: events.filter((event) => event.type === 'gateway_request').length,
        liabilityUsd: (run.parallelLiabilityMicro ?? 0) / 1e6,
        seconds: run.elapsedMs / 1000,
        answerChars: (run.answer ?? '').length,
        input: usage.input ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        output: usage.output ?? 0,
        contextTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
        totalTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0),
        attribution,
        toolSchemaCharsPerRequest: requests ? attribution.toolSchemaChars / requests : 0,
        systemCharsPerRequest: requests ? attribution.systemChars / requests : 0,
      });
    }
  }
  return rows;
}

export function armTotals(rows: RunRow[], arm: string) {
  const subset = rows.filter((row) => row.arm === arm);
  const sum = (pick: (row: RunRow) => number) => subset.reduce((total, row) => total + pick(row), 0);
  const attribution = empty();
  for (const row of subset) {
    attribution.systemChars += row.attribution.systemChars;
    attribution.toolSchemaChars += row.attribution.toolSchemaChars;
    attribution.userChars += row.attribution.userChars;
    attribution.assistantChars += row.attribution.assistantChars;
    attribution.toolResultChars += row.attribution.toolResultChars;
    attribution.totalChars += row.attribution.totalChars;
    for (const [tool, chars] of Object.entries(row.attribution.byTool)) {
      attribution.byTool[tool] = (attribution.byTool[tool] ?? 0) + chars;
    }
  }
  return {
    arm,
    runs: subset.length,
    contextTokens: sum((row) => row.contextTokens),
    totalTokens: sum((row) => row.totalTokens),
    output: sum((row) => row.output),
    requests: sum((row) => row.requests),
    toolCalls: sum((row) => row.toolCalls),
    dispatches: sum((row) => row.dispatches),
    liabilityUsd: sum((row) => row.liabilityUsd),
    limitHits: subset.filter((row) => row.status === 'limit').length,
    attribution,
    charsPerContextToken: attribution.totalChars / sum((row) => row.contextTokens),
  };
}

if (process.argv[1] === import.meta.filename) {
  const rows = loadRuns('primary');
  const summary = { generatedAt: new Date().toISOString(), rows, arms: ['E', 'C'].map((arm) => armTotals(rows, arm)) };
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(summary, null, 2));

  // Acceptance: reproduce the published round-1 aggregates exactly.
  const published = { E: { context: 534285, total: 545372 }, C: { context: 285974, total: 297828 } };
  const failures: string[] = [];
  for (const arm of ['E', 'C'] as const) {
    const totals = summary.arms.find((entry) => entry.arm === arm)!;
    if (totals.contextTokens !== published[arm].context) {
      failures.push(`${arm} context ${totals.contextTokens} != ${published[arm].context}`);
    }
    if (totals.totalTokens !== published[arm].total) {
      failures.push(`${arm} total ${totals.totalTokens} != ${published[arm].total}`);
    }
  }
  for (const totals of summary.arms) {
    const a = totals.attribution;
    console.log(
      `${totals.arm}: runs ${totals.runs} context ${totals.contextTokens} requests ${totals.requests} ` +
        `| schema ${a.toolSchemaChars} system ${a.systemChars} toolResults ${a.toolResultChars} ` +
        `user ${a.userChars} assistant ${a.assistantChars} | chars/token ${totals.charsPerContextToken.toFixed(2)}`,
    );
    const byTool = Object.entries(a.byTool).sort((x, y) => y[1] - x[1]);
    console.log(`   tool results: ${byTool.map(([name, chars]) => `${name} ${chars}`).join(', ')}`);
  }
  console.log(failures.length ? `ACCEPTANCE FAILED: ${failures.join('; ')}` : 'ACCEPTANCE OK: published totals reproduced');
}
