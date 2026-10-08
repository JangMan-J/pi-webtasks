/** Small routing screen: live model + real extension, local Parallel fixtures. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { random } from './core.ts';

export type ReachCase = { id: string; prompt: string; tool: string; args: Record<string, unknown>; answer: string; first?: string };
export const REACH_CASES: ReachCase[] = [
  { id: 'search', prompt: 'Find an authoritative source for the public release date of FixtureDB 8. Report the date with its source URL.', tool: 'parallel_search', args: {}, answer: '2030-02-03' },
  { id: 'extract', prompt: 'Read https://example.com/fixturedb/release and report the FixtureDB 8 release date with its source URL.', tool: 'parallel_extract', args: { urls: ['https://example.com/fixturedb/release'] }, answer: '2030-02-03' },
  { id: 'responses', prompt: 'Use a cited synthesis to summarize the FixtureDB 8 release announcement. No preliminary source discovery is needed.', tool: 'parallel_responses', args: {}, answer: '2030-02-03' },
  { id: 'task', prompt: 'Retrieve the completed Parallel Task run_id tr_fixture. Report its output verbatim. Do not create a new run or substitute web research.', tool: 'parallel_task', args: { action: 'result', run_id: 'tr_fixture' }, answer: 'Task marker: cobalt.' },
  { id: 'memory', prompt: 'Retrieve prior Parallel Task research from memory_scope_key reach_fixture using query release. Report the saved finding. Do not rerun research.', tool: 'parallel_memory', args: { action: 'retrieve', kind: 'task', memory_scope_key: 'reach_fixture' }, answer: 'Memory marker: amber.' },
  { id: 'findall', prompt: 'Retrieve results for the existing Parallel findall_id fa_fixture. Report the matching company. Do not create, extend, or enrich a run.', tool: 'parallel_findall', args: { action: 'result', findall_id: 'fa_fixture' }, answer: 'Harbor Robotics' },
  { id: 'entities', prompt: 'Discover robotics companies in Finland as a matching entity set, not a list of web articles. Use a lightweight company lookup and report the first match. Do not start a full discovery run.', tool: 'parallel_findall', args: { action: 'entity_search', entity_type: 'companies' }, answer: 'Harbor Robotics' },
  { id: 'mixed', prompt: 'First read https://example.com/fixturedb/release and report its release date. Then retrieve the completed Parallel Task run_id tr_fixture and report its output verbatim. Do not create another Task.', first: 'parallel_extract', tool: 'parallel_task', args: { action: 'result', run_id: 'tr_fixture' }, answer: 'Task marker: cobalt.' },
  { id: 'artifact', prompt: 'Retrieve completed Parallel Task tr_artifact with return_mode file. Read its saved output locally and report the final verification marker verbatim. Do not create a new run.', tool: 'parallel_task', args: { action: 'result', run_id: 'tr_artifact', return_mode: 'file' }, answer: 'jade-73' },
];
const DEFERRED = ['parallel_task', 'parallel_group', 'parallel_findall', 'parallel_monitor', 'parallel_memory', 'parallel_account'];
export type ProbeCall = { name: string; args: any; index: number; requestIndex?: number };
export function artifactNavigation(calls: ProbeCall[]): boolean {
  return calls.some(c => ['read', 'bash'].includes(c.name) && /parallelized[\\/]results/.test(JSON.stringify(c.args)));
}
export function scoreReach(entry: ReachCase, condition: string, calls: ProbeCall[], answer: string, errors: unknown[] = []) {
  const activations = calls.filter(c => c.name === 'parallel_tools');
  const required = DEFERRED.includes(entry.tool);
  const match = calls.find(c => c.name === entry.tool && Object.entries(entry.args).every(([key, value]) => JSON.stringify(c.args?.[key]) === JSON.stringify(value)));
  const activated = activations.flatMap(c => Array.isArray(c.args?.tools) ? c.args.tools : []);
  const unnecessary = condition === 'baseline' || !required ? activations.length : Math.max(0, activations.length - 1) + activated.filter(n => n !== entry.tool).length;
  const first = entry.first ? calls.find(c => c.name === entry.first) : undefined;
  const expectedActivation = condition === 'lazy' && required;
  const missed = expectedActivation && (!activated.includes(entry.tool) || !match || !activations.some(c => c.index < match.index));
  const forbidden = calls.some(c => DEFERRED.includes(c.name) && c.name !== entry.tool || ['create', 'extend', 'enrich', 'clear', 'evict', 'add_credit'].includes(c.args?.action));
  const ordered = !entry.first || !!(first && match && first.index < match.index);
  const output = answer.includes(entry.answer) && (required || answer.includes('https://example.com/fixturedb/release')) && (entry.id !== 'mixed' || answer.includes('2030-02-03'));
  return { pass: !!match && output && ordered && !missed && !unnecessary && !forbidden && !errors.length,
    requiredOperation: !!match, output, ordered, missedActivation: missed, unnecessaryActivation: unnecessary,
    activationCalls: activations.length, activationIndex: activations[0]?.index ?? null,
    activationRequestIndex: activations[0]?.requestIndex ?? null,
    forbiddenOperation: forbidden, artifactNavigation: artifactNavigation(calls), toolCalls: calls.length };
}

/** Keep both conditions of a pair in the same artifact-navigation stratum. */
export function reachStrata(rows: any[]) {
  const key = (r: any) => `${r.case}-${r.repeat}`;
  const artifactPairs = new Set(rows.filter(r => r.artifactNavigation).map(key));
  return Object.fromEntries([
    ['all', rows],
    ['artifactNavigation', rows.filter(r => artifactPairs.has(key(r)))],
    ['withoutArtifactNavigation', rows.filter(r => !artifactPairs.has(key(r)))],
  ].map(([name, subset]: any) => [name, ['baseline', 'lazy'].map(condition => {
    const group = subset.filter((r: any) => r.condition === condition);
    return { condition, n: group.length, cumulativeInputTokens: group.reduce((n: number, r: any) => n + r.cumulativeInputTokens, 0), passes: group.filter((r: any) => r.pass).length };
  })]));
}

/** Fixtures are intentionally not claims about live Parallel research. Unknown operations fail closed. */
export function fixtureResponse(method: string, pathname: string, body: any): { status: number; data: unknown } {
  const source = { title: 'FixtureDB release', url: 'https://example.com/fixturedb/release', excerpts: ['FixtureDB 8 was released on 2030-02-03.'] };
  if (method === 'POST' && ['/v1/search', '/v1/extract'].includes(pathname)) return { status: 200, data: { results: [source] } };
  if (method === 'POST' && pathname === '/v1/responses') return { status: 200, data: { id: 'resp_fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FixtureDB 8 was released on 2030-02-03. https://example.com/fixturedb/release', annotations: [{ type: 'url_citation', url: source.url, title: source.title }] }] }] } };
  if (method === 'GET' && /^\/v1\/tasks\/runs\/tr_(fixture|artifact)\/result$/.test(pathname)) {
    const id = pathname.split('/')[4];
    return { status: 200, data: { run: { run_id: id, status: 'completed' }, output: { type: 'text', content: id === 'tr_artifact' ? 'Saved fixture evidence. '.repeat(500) + 'Verification marker: jade-73.' : 'Task marker: cobalt.', basis: [] } } };
  }
  if (method === 'POST' && pathname === '/v1beta/memory/retrieve' && body.memory_scope_key === 'reach_fixture') return { status: 200, data: { memories: [{ kind: 'task', id: 'tr_saved', content: 'Memory marker: amber.' }] } };
  const candidates = [{ name: 'Harbor Robotics', url: 'https://example.com/harbor', description: 'Robotics company in Finland' }];
  if (method === 'GET' && pathname === '/v1beta/findall/runs/fa_fixture/result') return { status: 200, data: { run: { findall_id: 'fa_fixture', status: { status: 'completed', is_active: false } }, candidates } };
  if (method === 'POST' && pathname === '/v1beta/findall/entity-search') return { status: 200, data: { findall_id: 'fa_fixture', status: { status: 'completed' }, candidates } };
  return { status: 400, data: { error: 'Unsupported fixture operation; no request was forwarded.' } };
}

async function run(out: string, repeats: number, cases: ReachCase[]) {
  const root = path.resolve(import.meta.dirname, '..');
  const provider = process.env.REACH_PROVIDER ?? 'openai-codex';
  const model = process.env.REACH_MODEL ?? 'gpt-5.5';
  const thinking = process.env.REACH_THINKING ?? 'high';
  await mkdir(out, { recursive: true });
  // Exclusive receipt prevents overwriting an earlier screening run.
  await writeFile(path.join(out, 'start.json'), JSON.stringify({ provider, model, thinking, repeats, cases: cases.map(c => c.id), started: new Date().toISOString(), fixtureAPI: true }), { flag: 'wx' });
  const hashes = await Promise.all(['src/index.ts', 'src/results.ts', 'src/evidence.ts', 'bench/reach.ts'].map(async file => {
    const text = await readFile(path.join(root, file), 'utf8');
    await writeFile(path.join(out, file.replaceAll('/', '__')), text, { flag: 'wx' });
    return [file, createHash('sha256').update(text).digest('hex')];
  }));
  await writeFile(path.join(out, 'source-hashes.json'), JSON.stringify(Object.fromEntries(hashes), null, 2));
  const next = random(20260923);
  const jobs = cases.flatMap(entry => Array.from({ length: repeats }, (_, repeat) => ({ entry, repeat, order: next() < .5 ? ['baseline', 'lazy'] : ['lazy', 'baseline'] })));
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  const rows: any[] = [];
  async function pair(job: typeof jobs[number]) {
    for (const condition of job.order) {
      const id = `${job.entry.id}-${job.repeat}-${condition}`;
      const dir = path.join(out, id);
      await mkdir(dir);
      const workspace = await mkdtemp(path.join(tmpdir(), 'parallel-reach-'));
      const requests: unknown[] = [];
      const server = createServer(async (req, res) => {
        try {
          let raw = ''; for await (const part of req) raw += part;
          const body = raw ? JSON.parse(raw) : {};
          const pathname = new URL(req.url!, 'http://localhost').pathname;
          const response = fixtureResponse(req.method!, pathname, body);
          requests.push({ method: req.method, pathname, body, status: response.status });
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response.data));
        } catch { res.writeHead(400); res.end('{}'); }
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      const start = Date.now();
      let stdout = '', stderr = '', timedOut = false;
      let code: number | null = null;
      try {
        const child = spawn(process.env.PI_BIN ?? 'pi', ['--provider', provider, '--model', model, '--thinking', thinking,
          '--mode', 'json', '--print', '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--offline',
          '--exclude-tools', 'bash,edit,write', '-e', path.join(root, 'src/index.ts'),
          '--append-system-prompt', 'This is a tool-routing integration test. The research service returns synthetic fixtures, not claims about real products. Report fixture values as test data. Do not verify the fixtures against the live web.',
          '--', job.entry.prompt], {
          cwd: workspace, env: { ...process.env, PIPARA_API_KEY: 'local-fixture-only', PARALLEL_API_KEY: 'local-fixture-only', PARALLEL_BASE_URL: base,
            PARALLEL_API_URL: base, PARALLEL_PLATFORM_URL: base, PARALLEL_SERVICE_API_URL: base, PIPARA_LAZY_TOOLS: condition === 'lazy' ? '1' : '0',
            PIPARA_WEBHOOK_DIR: '', PIPARA_OUTPUT_FORMAT: 'readable', PI_OFFLINE: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 180_000);
        try { [code] = await once(child, 'close') as [number | null]; } finally { clearTimeout(timer); }
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      const events = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { type: 'parse_error', line }; } });
      const assistants = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message);
      let requestIndex = 0;
      const calls: ProbeCall[] = [];
      for (const e of events) {
        if (e.type === 'message_end' && e.message?.role === 'assistant') requestIndex++;
        if (e.type === 'tool_execution_start') calls.push({ name: e.toolName, args: e.args, index: calls.length, requestIndex });
      }
      const answer = assistants.flatMap(m => m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text)).join('\n');
      const errors = events.filter(e => e.type === 'parse_error' || e.type === 'extension_error' || e.type === 'tool_execution_end' && e.isError || e.type === 'message_end' && ['error', 'aborted'].includes(e.message?.stopReason));
      if (timedOut || code !== 0) errors.push({ timedOut, code });
      const inputs = assistants.map(m => (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0));
      const row = { id, case: job.entry.id, repeat: job.repeat, condition, workspace, ...scoreReach(job.entry, condition, calls, answer, errors),
        errors, calls, answer, requests, seconds: (Date.now() - start) / 1000, turns: assistants.length,
        cumulativeInputTokens: inputs.reduce((a, b) => a + b, 0), peakInputTokens: Math.max(0, ...inputs),
        outputTokens: assistants.reduce((sum, m) => sum + (m.usage?.output ?? 0), 0),
        nominalCost: assistants.reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0),
        actualModels: [...new Set(assistants.map(m => `${m.provider}/${m.model}`))] };
      await Promise.all([writeFile(path.join(dir, 'events.jsonl'), stdout), writeFile(path.join(dir, 'stderr.txt'), stderr), writeFile(path.join(dir, 'result.json'), JSON.stringify(row, null, 2))]);
      rows.push(row);
      console.log(JSON.stringify({ id, pass: row.pass, errors: errors.length, calls: calls.map(c => c.name), seconds: row.seconds }));
    }
  }
  // Four independent cases; paired conditions stay serial within each case.
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { let job; while ((job = queue.shift())) await pair(job); }));
  const summary = { generated: new Date().toISOString(), fixtureAPI: true, provider, model, thinking, repeats, passed: rows.filter(r => r.pass).length, total: rows.length,
    strata: reachStrata(rows), rows };
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  if (summary.passed !== summary.total) process.exitCode = 1;
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.includes('--help')) console.log('Usage: node bench/reach.ts OUTPUT_DIRECTORY [REPEATS=2] [CASE ...]\nLive model routing screen with a local Parallel fixture API; no Parallel billing. REACH_PROVIDER/MODEL/THINKING select the model.');
  else {
    const repeats = Number(process.argv[3] ?? 2);
    if (!process.argv[2] || !Number.isInteger(repeats) || repeats < 1) throw Error('Supply a new output directory and positive integer repeat count. Use --help.');
    const names = process.argv.slice(4);
    if (names.some(name => !REACH_CASES.some(c => c.id === name))) throw Error('Unknown case. Expected: ' + REACH_CASES.map(c => c.id).join(', '));
    const cases = names.length ? REACH_CASES.filter(c => names.includes(c.id)) : REACH_CASES;
    await run(path.resolve(process.argv[2]), repeats, cases);
  }
}
