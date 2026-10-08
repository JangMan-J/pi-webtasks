/**
 * Tier 1 runner: one extension build, two conditions.
 *
 *   baseline  PIPARA_LAZY_TOOLS=0, all nine research tools active
 *   lazy      PIPARA_LAZY_TOOLS=1, six tools deferred behind `parallel_tools`
 *
 * Both conditions use the same image, mounts, model, prompts, gold, and
 * gateway as arm E of round 1, so the only difference is the flag. The
 * round-1 runner (`bench/run.ts`) is left untouched; its pairs and ledger
 * entries stay as recorded.
 *
 * Ledger note: the spend ledger stores two slots per pair, named E and C.
 * Here E is the baseline condition and C is the lazy condition. Every run
 * record carries an explicit `condition` field; do not read the ledger's arm
 * letter as a round-1 arm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { ROOT, exec, readJSON, saveJSON, sha, jsonLines, random } from './core.ts';
import { initWorkspace, launch, stageObserver, sanitize } from './sandbox.ts';
import { withCredentials } from './auth.ts';
import { createGateway } from './gateway.ts';

/**
 * Historical search-centric cases. R1 permits direct source retrieval and
 * did not exercise activation; it is not a must-activate case. Use the reach
 * screening cases for existing Task/FindAll IDs and scoped Memory retrieval.
 */
export const TIER1_CASES = ['D1', 'D3', 'S2', 'K1', 'E2', 'L2', 'R1'] as const;

export const CONDITIONS = { E: 'baseline', C: 'lazy' } as const;

/**
 * Round 2 bounds the run by wall clock, not by call count. The round-1 caps
 * (12 requests, 20 tool calls) would terminate legitimate work on questions
 * that require reading several pinned source files, and a terminated run
 * scores as a failure for reasons unrelated to tooling. Spending stays bounded
 * by the gateway's per-run ceiling, which is the control that actually matters.
 * The token and output numbers below are runaway backstops, not budgets; they
 * are not expected to bind before the deadline does.
 */
export const WALL_CLOCK_LIMITS = {
  BENCH_MAX_REQUESTS: 1000,
  BENCH_MAX_TOOL_CALLS: 1000,
  BENCH_MAX_TOKENS: 4_000_000,
  BENCH_MAX_OUTPUT: 32_000,
} as const;

/** Per-run wall clock for round 2, identical in every cell. */
export const ROUND2_DEADLINE_MS = 30 * 60 * 1000;

/** Per-case order randomization, seeded for reproducibility. */
export function tier1Schedule(seed: number) {
  const next = random(seed);
  const shuffle = <T>(values: T[]): T[] => {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const cases = shuffle([...TIER1_CASES]);
  return cases.map((caseId, index) => ({
    pairId: `tier1-${caseId}`,
    phase: 'primary' as const,
    caseId,
    order: index % 2 === 0 ? (['E', 'C'] as const) : (['C', 'E'] as const),
  }));
}

if (process.argv[1] === import.meta.filename) {
  const spec = readJSON(path.join(ROOT, 'docs/benchmark-cases.json'));
  const manifest = readJSON(path.join(ROOT, 'bench/manifest.json'));
  const setup = readJSON(path.join(manifest.runtime, 'setup.json'));
  stageObserver(setup);

  const catalog = new Map<string, any>();
  const walk = (node: any) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.id && node.prompt) catalog.set(node.id, node);
      Object.values(node).forEach(walk);
    }
  };
  walk(spec);

  const data = path.join(ROOT, '.pi/benchmark/data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const lock = path.join(data, 'runner.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeSync(fd, String(process.pid));

  const results: any[] = [];
  let gateway: any;
  try {
    // secretspec first, as in round 1; the environment is the documented
    // fallback for this host. The key stays in the gateway process and never
    // reaches a container or a log line.
    let apiKey = '';
    try {
      const { stdout } = await exec('secretspec', ['get', 'PIPARA_API_KEY', '--caller', 'pi-parallelized', '--reason', 'User-authorized Tier 1 lazy-tool comparison with pre-dispatch spending limits'], { maxBuffer: 100000 });
      apiKey = stdout.trim();
    } catch {
      apiKey = (process.env.PIPARA_API_KEY ?? process.env.PARALLEL_API_KEY ?? '').trim();
    }
    if (!apiKey) throw Error('No Parallel API key available from secretspec or the environment');
    gateway = createGateway({ dbPath: path.join(data, 'liability.sqlite'), apiKey });
    gateway.server.listen(0, '0.0.0.0');
    await once(gateway.server, 'listening');
    const base = `http://host.containers.internal:${gateway.server.address().port}`;

    // Optional case filter: `node bench/ab-run.ts L1` runs one case, which is
  // how the zero-cost smoke is taken without consuming a scheduled pair.
  const only = new Set(process.argv.slice(2));
  const scheduled = only.size
    ? [...only].map((caseId, index) => ({ pairId: `tier1-${caseId}`, phase: 'primary' as const, caseId, order: (index % 2 === 0 ? ['E', 'C'] : ['C', 'E']) as readonly ('E' | 'C')[] }))
    : tier1Schedule(manifest.seed ?? spec.seed);

  for (const pair of scheduled) {
      const entry = catalog.get(pair.caseId);
      if (!entry) throw Error(`Case ${pair.caseId} missing from the catalog`);
      const pairDir = path.join(data, pair.pairId);
      if (fs.existsSync(path.join(pairDir, 'pair.json'))) throw Error(`Pair already attempted: ${pair.pairId}; no automatic reruns`);
      fs.mkdirSync(pairDir, { recursive: true, mode: 0o700 });
      saveJSON(path.join(pairDir, 'pair.json'), { ...pair, conditions: CONDITIONS, startedAt: new Date().toISOString() });
      const capMicro = entry.per_arm_max_usd === 0 ? 0 : 250000;
      const reservations = gateway.ledger.registerPair({ pairId: pair.pairId, phase: pair.phase, armCapMicro: capMicro });

      for (const slot of pair.order) {
        const condition = CONDITIONS[slot];
        const identity = reservations[slot];
        const runId = identity.runId;
        const out = path.join(pairDir, condition);
        const work = path.join(out, 'work');
        fs.mkdirSync(out, { recursive: true });
        initWorkspace(setup, work, path.join(ROOT, 'bench/fixtures', pair.caseId));
        const envFile = path.join(out, 'research.env');
        fs.writeFileSync(
          envFile,
          [
            `PIPARA_API_KEY=${identity.token}`,
            `PARALLEL_API_KEY=${identity.token}`,
            `PARALLEL_BASE_URL=${base}`,
            `PARALLEL_API_URL=${base}`,
            `PARALLEL_PLATFORM_URL=${base}/denied/platform`,
            `PARALLEL_SERVICE_API_URL=${base}/denied/account`,
            `BENCH_CONDITION=${condition}`,
            ...Object.entries(WALL_CLOCK_LIMITS).map(([key, value]) => `${key}=${value}`),
            `PIPARA_LAZY_TOOLS=${condition === 'lazy' ? '1' : '0'}`,
          ].join('\n') + '\n',
          { mode: 0o600 },
        );
        saveJSON(path.join(out, 'run-start.json'), { runId, caseId: pair.caseId, condition, startedAt: new Date().toISOString() });

        const deadlineMs = entry.deadline_ms ?? ROUND2_DEADLINE_MS;
        let processResult: any;
        let harnessError: string | undefined;
        try {
          processResult = await withCredentials(setup, work, () =>
            launch(setup, 'E', work, runId, envFile, [entry.prompt, ...(entry.followup_prompt ? [entry.followup_prompt] : [])], deadlineMs, out),
          );
        } catch (error) {
          harnessError = error instanceof Error ? error.message : String(error);
        } finally {
          fs.rmSync(envFile, { force: true });
          gateway.ledger.finishRun(runId);
        }

        const events = jsonLines(path.join(work, 'events.jsonl'));
        const stream = jsonLines(path.join(out, 'stdout.jsonl'));
        const assistants = stream.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').map((event) => event.message);
        const answers = assistants
          .filter((message) => message.stopReason !== 'toolUse')
          .map((message) => message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'))
          .filter(Boolean);
        const usage = assistants.reduce(
          (totals: any, message: any) => {
            for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) totals[key] += message.usage?.[key] ?? 0;
            return totals;
          },
          { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        );
        const started = events.find((event) => event.type === 'prompt_audit');
        const finished = [...events].reverse().find((event) => event.type === 'run_end');
        const stamp = (event: any) => event?.mono ?? Date.parse(event?.ts ?? '');
        const elapsed = stamp(finished) - stamp(started);
        const limited = events.some((event) => ['limit', 'limit_stop', 'guard_stop'].includes(event.type));
        const auditFail = !events.some((event) => event.type === 'prompt_audit') || events.some((event) => event.type === 'prompt_audit' && event.ok !== true);
        const status = harnessError
          ? 'harness_error'
          : processResult?.timedOut
            ? 'timeout'
            : auditFail
              ? 'audit_failed'
              : limited
                ? 'limit'
                : !answers.length
                  ? 'failed'
                  : 'completed';

        const accounting = gateway.ledger.runStats(runId);
        for (const request of accounting.requests) {
          events.push({
            id: `${runId}:gateway:${request.id}`,
            type: request.status === 'denied' ? 'gateway_denial' : 'gateway_request',
            ts: request.at,
            method: request.method,
            path: request.path,
            body: JSON.parse(request.body),
            liabilityMicro: request.liability,
            status: request.status,
            httpStatus: request.http_status,
            error: request.error,
          });
        }
        events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        answers.forEach((text, index) => events.push({ id: `${runId}:answer:${index + 1}`, type: 'answer', index: index + 1, text }));

        const activationCalls = events.filter((event) => event.type === 'tool_call' && event.tool === 'parallel_tools').length;
        const record = {
          runId,
          parallelLiabilityMicro: accounting.parallelLiabilityMicro,
          pairId: pair.pairId,
          caseId: pair.caseId,
          phase: pair.phase,
          arm: 'E',
          condition,
          ledgerSlot: slot,
          model: setup.model,
          status,
          activationCalls,
          elapsedMs: Number.isFinite(elapsed) ? elapsed : processResult?.processElapsedMs ?? deadlineMs,
          deadlineMs,
          processElapsedMs: processResult?.processElapsedMs,
          usage,
          answer: answers.join('\n\n--- FOLLOW-UP ---\n\n'),
          answers,
          events: sanitize(events),
          harnessError,
          manifestHash: sha(fs.readFileSync(path.join(ROOT, 'bench/manifest.json'))),
        };
        saveJSON(path.join(out, 'run.json'), record);
        results.push({ pair: pair.pairId, condition, status, seconds: record.elapsedMs / 1000, context: usage.input + usage.cacheRead + usage.cacheWrite, activationCalls });
        console.log(JSON.stringify(results.at(-1)));
        if (harnessError) throw Error(`Harness error in ${pair.pairId}/${condition}; attempt retained`);
      }
    }
  } finally {
    if (gateway) {
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
      saveJSON(path.join(data, 'tier1-ledger.json'), gateway.ledger.stats());
      gateway.ledger.close();
    }
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
  saveJSON(path.join(ROOT, '.pi/benchmark/data/tier0/tier1-runs.json'), results);
}
