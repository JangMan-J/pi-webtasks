/**
 * Tier 0 WP0-3: where the extension's context cost actually goes.
 *
 * Component 1 (fixed): serialized tool schemas and system prompt, charged on
 * every provider request. Measured at HEAD through the real Pi loader and at
 * the round-1 pin through the preserved request payloads.
 * Component 2 (per result): tool result bytes, measured from the same payloads
 * and attributed to the producing tool.
 * Component 3 (projection): what each candidate intervention would remove.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns, armTotals, OUT } from './ab-metrics.ts';

/** Serialized size of the description strings inside a JSON Schema subtree. */
function descriptionChars(node: any): number {
  if (Array.isArray(node)) return node.reduce((total, item) => total + descriptionChars(item), 0);
  if (!node || typeof node !== 'object') return 0;
  let total = 0;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') total += value.length;
    else total += descriptionChars(value);
  }
  return total;
}

export async function headSchemas() {
  const { loadTools } = await import('../tests/helpers/test-host.ts');
  const { tools } = await loadTools();
  return [...tools].map(([name, definition]: any) => {
    const serialized = JSON.stringify({ type: 'function', function: { name, description: definition.description, parameters: definition.parameters } });
    return {
      name,
      chars: serialized.length,
      descriptionChars: (definition.description ?? '').length + descriptionChars(definition.parameters),
      promptChars:
        (definition.promptSnippet ?? '').length +
        (Array.isArray(definition.promptGuidelines) ? definition.promptGuidelines.join(' ').length : (definition.promptGuidelines ?? '').length),
    };
  });
}

/** Tool schemas exactly as the round-1 workers received them. */
export function pinSchemas(caseId = 'D1') {
  const run = JSON.parse(fs.readFileSync(`.pi/benchmark/data/primary-${caseId}/E/run.json`, 'utf8'));
  const payload = run.events.find((event: any) => event.type === 'provider_request').payload;
  return payload.tools.map((tool: any) => ({ name: tool.function.name, chars: JSON.stringify(tool).length, definition: tool.function }));
}

const CORE = new Set(['parallel_search', 'parallel_extract', 'parallel_responses']);

if (process.argv[1] === import.meta.filename) {
  const head = await headSchemas();
  const pin = pinSchemas();
  const pinByName = new Map<string, any>(pin.map((tool: any) => [tool.name, tool]));

  // Identity: did the always-visible surface change between pin and HEAD?
  const drift = head.filter((tool) => {
    const other = pinByName.get(tool.name);
    if (!other) return false;
    return other.definition.description !== undefined && JSON.stringify(other.definition.parameters) !== JSON.stringify((tool as any).parameters ?? other.definition.parameters);
  });

  const rows = loadRuns('primary');
  const arms = ['E', 'C'].map((arm) => armTotals(rows, arm));
  const e = arms[0];
  const c = arms[1];
  const charsPerToken = e.attribution.totalChars / e.contextTokens;

  const parallelHead = head.filter((tool) => tool.name.startsWith('parallel_'));
  const optional = parallelHead.filter((tool) => !CORE.has(tool.name));
  const schemaPerRequestE = e.attribution.toolSchemaChars / e.requests;
  const schemaPerRequestC = c.attribution.toolSchemaChars / c.requests;

  const scenarios = [
    {
      id: 'lazy-optional',
      label: 'Register 3 core research tools; expose the other 6 on demand',
      charsPerRequest: optional.reduce((total, tool) => total + tool.chars, 0),
    },
    {
      id: 'trim-descriptions-30',
      label: 'Trim 30% of schema description text, all 9 tools',
      charsPerRequest: parallelHead.reduce((total, tool) => total + tool.descriptionChars, 0) * 0.3,
    },
    {
      id: 'both',
      label: 'Lazy optional tools plus 30% description trim on the core 3',
      charsPerRequest:
        optional.reduce((total, tool) => total + tool.chars, 0) +
        parallelHead.filter((tool) => CORE.has(tool.name)).reduce((total, tool) => total + tool.descriptionChars, 0) * 0.3,
    },
  ].map((scenario) => {
    const savedChars = scenario.charsPerRequest * e.requests;
    return {
      ...scenario,
      savedChars,
      savedTokens: Math.round(savedChars / charsPerToken),
      shareOfEContext: savedChars / charsPerToken / e.contextTokens,
      shareOfGap: savedChars / charsPerToken / (e.contextTokens - c.contextTokens),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    charsPerToken,
    pinVsHead: {
      pinParallelChars: pin.filter((tool: any) => tool.name.startsWith('parallel_')).reduce((total: number, tool: any) => total + tool.chars, 0),
      headParallelChars: parallelHead.reduce((total, tool) => total + tool.chars, 0),
      driftingTools: drift.map((tool) => tool.name),
    },
    perRequest: {
      schemaCharsE: schemaPerRequestE,
      schemaCharsC: schemaPerRequestC,
      systemCharsE: e.attribution.systemChars / e.requests,
      systemCharsC: c.attribution.systemChars / c.requests,
    },
    corpus: {
      requestsE: e.requests,
      requestsC: c.requests,
      contextTokensE: e.contextTokens,
      contextTokensC: c.contextTokens,
      gapTokens: e.contextTokens - c.contextTokens,
      schemaTokensE: Math.round(e.attribution.toolSchemaChars / charsPerToken),
      schemaTokensC: Math.round(c.attribution.toolSchemaChars / charsPerToken),
      toolResultTokensE: Math.round(e.attribution.toolResultChars / charsPerToken),
      toolResultTokensC: Math.round(c.attribution.toolResultChars / charsPerToken),
      systemTokensE: Math.round(e.attribution.systemChars / charsPerToken),
      systemTokensC: Math.round(c.attribution.systemChars / charsPerToken),
    },
    headSchemas: head,
    scenarios,
  };

  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, 'overhead.json'), JSON.stringify(report, null, 2));

  console.log(`chars per context token: ${charsPerToken.toFixed(2)}`);
  console.log(`pin vs HEAD parallel schema chars: ${report.pinVsHead.pinParallelChars} vs ${report.pinVsHead.headParallelChars}; drifting tools: ${drift.length ? drift.map((t) => t.name).join(',') : 'none'}`);
  console.log(`per request  schema  E ${schemaPerRequestE.toFixed(0)}  C ${schemaPerRequestC.toFixed(0)}  | system  E ${(e.attribution.systemChars / e.requests).toFixed(0)}  C ${(c.attribution.systemChars / c.requests).toFixed(0)}`);
  console.log(
    `corpus tokens  schema E ${report.corpus.schemaTokensE} C ${report.corpus.schemaTokensC} | toolResults E ${report.corpus.toolResultTokensE} C ${report.corpus.toolResultTokensC} | system E ${report.corpus.systemTokensE} C ${report.corpus.systemTokensC} | gap ${report.corpus.gapTokens}`,
  );
  for (const scenario of scenarios) {
    console.log(
      `${scenario.id.padEnd(22)} saves ${String(scenario.savedTokens).padStart(7)} tokens = ${(scenario.shareOfEContext * 100).toFixed(1)}% of E context, ${(scenario.shareOfGap * 100).toFixed(1)}% of the E-C gap`,
    );
  }
}
