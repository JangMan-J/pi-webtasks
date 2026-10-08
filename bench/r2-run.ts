/**
 * Round 2 runner: eight transcript-sourced questions, two arms.
 *
 *   E  the extension (all nine research tools active)
 *   C  stock parallel-cli + the quarantined Pi skills
 *
 * Same images, mounts, gateway, and isolation as round 1. Differences that are
 * deliberate and identical in both arms: wall-clock bound instead of call caps,
 * a high-thinking worker, and a reporting wrapper that asks for a structured
 * JSON tail (RIDDLER-FORMAT-B-20260922). Reference answers and traps live in
 * bench/gold-round2.json and are never mounted.
 *
 * Route attribution is recorded per run: gateway dispatches through the
 * research interface versus direct HTTP from the shell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { ROOT, exec, readJSON, saveJSON, sha, jsonLines, random } from './core.ts';
import { initWorkspace, launch, stageObserver, sanitize } from './sandbox.ts';
import { withCredentials } from './auth.ts';
import { createGateway } from './gateway.ts';
import { WALL_CLOCK_LIMITS, ROUND2_DEADLINE_MS } from './ab-run.ts';

export const GOLD = path.join(ROOT, 'bench/gold-round2.json');

/** Worker-visible prompt: verbatim question, base wrapper, JSON wrapper with substitutions. */
export function buildPrompt(gold: any, id: string): string {
  const entry = gold.cases[id];
  const fields = Object.entries(entry.facts_fields).map(([name, kind]) => `${name}:${kind}`).join(', ');
  const jsonWrapper = gold.worker_visible.json_wrapper.replace('{QUESTION_ID}', id).replace('{FACTS_FIELDS}', fields);
  return `${entry.question}\n\n${gold.worker_visible.base_wrapper}\n\n${jsonWrapper}`;
}

/** Extract the final fenced JSON block, if any; null on absence or parse failure. */
export function extractJsonTail(answer: string): { json: any; raw: string } | null {
  const fences = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  if (!fences.length) return null;
  const raw = fences[fences.length - 1][1];
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return null;
  }
}

/**
 * Shell-route classification. A command is attributed to exactly one route,
 * checked in this order: the Parallel CLI or Responses helper (the C arm's
 * research interface), Context7 (shared by both arms), then raw HTTP. The
 * first version matched any `https://` as direct HTTP, which misfiled
 * `parallel-cli extract 'https://...'` as a bypass of the interface.
 */
const CLI_INTERFACE = /\bparallel-(cli|research)\b/;
const CONTEXT7 = /\bctx7\b/;
const DIRECT_HTTP = /\b(curl|wget|urllib|requests\.get|fetch\(|gh api|npm view|npm pack|git (clone|ls-remote|fetch))\b|https?:\/\//i;

export function shellRoute(command: string): 'cli' | 'context7' | 'direct' | 'other' {
  if (CLI_INTERFACE.test(command)) return 'cli';
  if (CONTEXT7.test(command)) return 'context7';
  if (DIRECT_HTTP.test(command)) return 'direct';
  return 'other';
}

export function routeAttribution(events: any[]) {
  const dispatches = events.filter((event) => event.type === 'gateway_request');
  const bash = events.filter((event) => event.type === 'tool_call' && event.tool === 'bash');
  const routed = bash.map((event) => ({ event, route: shellRoute(String(event.input?.command ?? JSON.stringify(event.input ?? {}))) }));
  const direct = routed.filter((entry) => entry.route === 'direct').map((entry) => entry.event);
  const byRoute: Record<string, number> = {};
  for (const event of dispatches) byRoute[event.path] = (byRoute[event.path] ?? 0) + 1;
  return {
    interfaceDispatches: dispatches.length,
    interfaceByRoute: byRoute,
    directHttpCalls: direct.length,
    cliInterfaceCalls: routed.filter((entry) => entry.route === 'cli').length,
    context7Calls: routed.filter((entry) => entry.route === 'context7').length,
    directHttpSample: direct.slice(0, 5).map((event) => String(event.input?.command ?? '').slice(0, 120)),
    usedInterface: dispatches.length > 0,
    usedDirectHttp: direct.length > 0,
  };
}

export function schedule(seed: number, ids: string[]) {
  const next = random(seed);
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.map((caseId, index) => ({
    pairId: `r2-${caseId}`,
    caseId,
    order: (index % 2 === 0 ? ['E', 'C'] : ['C', 'E']) as readonly ('E' | 'C')[],
  }));
}

if (process.argv[1] === import.meta.filename) {
  const gold = readJSON(GOLD);
  const manifest = readJSON(path.join(ROOT, 'bench/manifest.json'));
  const frozen = readJSON(path.join(manifest.runtime, 'setup.json'));
  // Round 2 worker: gpt-5.6-sol at high thinking, via the built-in openai-codex
  // provider (OAuth; bench/auth.ts clones and writes back the rotated token).
  // The frozen setup.json is not modified; the override is explicit here.
  const setup = {
    ...frozen,
    provider: 'openai-codex',
    modelId: 'gpt-5.6-sol',
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'high',
  };
  stageObserver(setup);

  const only = process.argv.slice(2).filter((arg) => /^Q[1-8]$/.test(arg));
  const ids = only.length ? only : Object.keys(gold.cases);
  // Retries never reuse a pair id: the ledger keys runs by pair id and arm and
  // refuses duplicates. `--attempt N` gives a retry a distinct id while the
  // case id stays the same for reporting. Failed attempts are archived, not
  // overwritten.
  const attemptArg = process.argv.find((arg) => arg.startsWith('--attempt='));
  const attempt = attemptArg ? Number(attemptArg.split('=')[1]) : 1;
  const suffix = attempt > 1 ? `-a${attempt}` : '';
  const goldHash = sha(fs.readFileSync(GOLD));

  const data = path.join(ROOT, '.pi/benchmark/data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const lock = path.join(data, 'runner.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeSync(fd, String(process.pid));

  const results: any[] = [];
  let gateway: any;
  try {
    let apiKey = '';
    try {
      const { stdout } = await exec('secretspec', ['get', 'PIPARA_API_KEY', '--caller', 'pi-parallelized', '--reason', 'User-authorized round 2 benchmark with pre-dispatch spending limits'], { maxBuffer: 100000 });
      apiKey = stdout.trim();
    } catch {
      apiKey = (process.env.PIPARA_API_KEY ?? process.env.PARALLEL_API_KEY ?? '').trim();
    }
    if (!apiKey) throw Error('No Parallel API key available');
    gateway = createGateway({ dbPath: path.join(data, 'liability.sqlite'), apiKey });
    gateway.server.listen(0, '0.0.0.0');
    await once(gateway.server, 'listening');
    const base = `http://host.containers.internal:${gateway.server.address().port}`;

    for (const scheduled of schedule(manifest.seed ?? 42017, ids)) {
      const pair = { ...scheduled, pairId: `${scheduled.pairId}${suffix}`, attempt };
      const pairDir = path.join(data, pair.pairId);
      if (fs.existsSync(path.join(pairDir, 'pair.json'))) throw Error(`Pair already attempted: ${pair.pairId}; no automatic reruns`);
      fs.mkdirSync(pairDir, { recursive: true, mode: 0o700 });
      saveJSON(path.join(pairDir, 'pair.json'), { ...pair, goldHash, model: setup.model, startedAt: new Date().toISOString() });
      const reservations = gateway.ledger.registerPair({ pairId: pair.pairId, phase: 'primary', armCapMicro: 250000 });
      const prompt = buildPrompt(gold, pair.caseId);

      for (const arm of pair.order) {
        const identity = reservations[arm];
        const runId = identity.runId;
        const out = path.join(pairDir, arm);
        const work = path.join(out, 'work');
        fs.mkdirSync(out, { recursive: true });
        initWorkspace(setup, work);
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
            'BENCH_CONDITION=baseline',
            'PIPARA_LAZY_TOOLS=0',
            ...Object.entries(WALL_CLOCK_LIMITS).map(([key, value]) => `${key}=${value}`),
          ].join('\n') + '\n',
          { mode: 0o600 },
        );
        saveJSON(path.join(out, 'run-start.json'), { runId, caseId: pair.caseId, arm, startedAt: new Date().toISOString() });
        fs.writeFileSync(path.join(out, 'prompt.txt'), prompt);

        let processResult: any;
        let harnessError: string | undefined;
        let credentialWriteback: any = null;
        try {
          processResult = await withCredentials(
            setup,
            work,
            () => launch(setup, arm, work, runId, envFile, [prompt], ROUND2_DEADLINE_MS, out),
            (writeback) => { credentialWriteback = writeback; },
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
            for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']) totals[key] += message.usage?.[key] ?? 0;
            return totals;
          },
          { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        );
        const started = events.find((event) => event.type === 'prompt_audit');
        const finished = [...events].reverse().find((event) => event.type === 'run_end');
        const stamp = (event: any) => event?.mono ?? Date.parse(event?.ts ?? '');
        const elapsed = stamp(finished) - stamp(started);
        const limited = events.some((event) => ['limit', 'limit_stop', 'guard_stop'].includes(event.type));
        const auditFail = !events.some((event) => event.type === 'prompt_audit') || events.some((event) => event.type === 'prompt_audit' && event.ok !== true);
        const status = harnessError ? 'harness_error' : processResult?.timedOut ? 'timeout' : auditFail ? 'audit_failed' : limited ? 'limit' : !answers.length ? 'failed' : 'completed';

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

        const answer = answers.join('\n\n');
        const tail = extractJsonTail(answer);
        const route = routeAttribution(events);
        const record = {
          runId,
          parallelLiabilityMicro: accounting.parallelLiabilityMicro,
          pairId: pair.pairId,
          caseId: pair.caseId,
          arm,
          model: setup.model,
          status,
          elapsedMs: Number.isFinite(elapsed) ? elapsed : processResult?.processElapsedMs ?? ROUND2_DEADLINE_MS,
          deadlineMs: ROUND2_DEADLINE_MS,
          usage,
          requests: events.filter((event) => event.type === 'provider_request').length,
          toolCalls: events.filter((event) => event.type === 'tool_call').length,
          route,
          jsonTail: tail?.json ?? null,
          jsonTailPresent: tail !== null,
          answer,
          answers,
          events: sanitize(events),
          harnessError,
          credentialWriteback,
          goldHash,
          manifestHash: sha(fs.readFileSync(path.join(ROOT, 'bench/manifest.json'))),
        };
        saveJSON(path.join(out, 'run.json'), record);
        results.push({ pair: pair.pairId, arm, status, minutes: +(record.elapsedMs / 60000).toFixed(1), context: usage.input + usage.cacheRead + usage.cacheWrite, reasoning: usage.reasoning, interface: route.interfaceDispatches, direct: route.directHttpCalls, json: tail !== null, usd: accounting.parallelLiabilityMicro / 1e6 });
        console.log(JSON.stringify(results.at(-1)));
        if (harnessError) throw Error(`Harness error in ${pair.pairId}/${arm}; attempt retained`);
      }
    }
  } finally {
    if (gateway) {
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
      saveJSON(path.join(data, 'r2-ledger.json'), gateway.ledger.stats());
      gateway.ledger.close();
    }
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
  saveJSON(path.join(data, 'r2-runs.json'), results);
}
