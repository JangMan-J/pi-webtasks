/**
 * Round 2 grader pass: Muse Spark 1.3 and Fugu Max, both at high thinking,
 * each grading every scored run independently. Scores are never averaged.
 *
 * Graders decide what the deterministic scorer cannot: prose contradictions
 * and traps (only unretracted endorsed assertions fail), the per-card judge
 * criterion, fields the scorer left open, and source support. Retrieval and
 * execution verification are checked mechanically from the trace elsewhere,
 * so graders are told not to rule on them.
 *
 * Blinding: run ids are opaque, arm is withheld, and tool and product names
 * are rewritten to neutral labels in both the answer and the action list.
 * Output formats can still hint at the arm; that limit is reported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, readJSON, saveJSON, sha } from './core.ts';
import { scoreRun } from './r2-score.ts';

export const RATERS = [
  { name: 'muse', provider: 'openrouter', model: 'meta/muse-spark-1.3', thinking: 'high' },
  { name: 'fugu', provider: 'openrouter', model: 'sakana/fugu-max', thinking: 'high' },
] as const;

const DATA = path.join(ROOT, '.pi/benchmark/data');
const OUT = path.join(DATA, 'grading/r2');
export const PI_CLI = '/home/jangpi/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const CONCURRENCY = 4;

export function invoke(args: string[], cwd: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', args, { cwd, timeout: 900000, maxBuffer: 16e6, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve({ stdout })));
    // Pi reads piped stdin until EOF even when a positional prompt is present.
    child.stdin?.end();
  });
}

/** Rewrite tool, product, and mount names that would reveal the arm. */
export function neutralize(text: string): string {
  return text
    .replace(/parallel-cli\s+(search|extract|research)/g, 'research-tool $1')
    .replace(/\bparallel-cli\b/g, 'research-tool')
    .replace(/\bparallel-research\b/g, 'research-tool responses')
    .replace(/\bparallel_(search|extract|responses|task|group|findall|monitor|memory|account|tools)\b/g, 'research_$1')
    .replace(/\bParallel (Search|Extract|Responses|Task|CLI)\b/g, 'research $1')
    .replace(/\b(api\.)?parallel\.ai\b/gi, 'research-service')
    .replace(/\/opt\/resources\/[^\s"'`)]+/g, '<skill-file>')
    .replace(/\/opt\/(extension|cli|helper|bench-bin)[^\s"'`)]*/g, '<tooling>')
    .replace(/\/work\/home\/\.pi\/agent\/parallelized\/results\/[^\s"'`)]+/g, '<saved-artifact>');
}

/** Compact, neutralized list of what the answering agent did. */
export function actionList(events: any[]): { n: number; action: string; detail: string }[] {
  return events
    .filter((event) => event.type === 'tool_call')
    .map((event, index) => {
      const tool = String(event.tool);
      const input = event.input ?? {};
      const detail = tool === 'bash' ? String(input.command ?? '') : tool === 'read' ? String(input.path ?? '') : JSON.stringify(input);
      const action = tool.startsWith('parallel_') ? neutralize(tool) : tool === 'bash' ? 'shell' : tool === 'read' ? 'read_file' : tool;
      return { n: index + 1, action, detail: neutralize(detail).replace(/\s+/g, ' ').slice(0, 220) };
    });
}

export const INSTRUCTIONS = `You are an independent grader for a research-agent benchmark. You receive the question; the author's reference answer, acceptable minimum, items explicitly NOT required, a card-specific judge criterion, and wrong-answer traps; the settling sources with their decisive passages; a deterministic pre-check of the answer's structured JSON fields; the answer under test (prose followed by a JSON block); and a neutralized list of the actions the answering agent took. Tool and product names are neutralized. Do not try to infer, reward, or penalize any particular toolchain.

Rules:
- Equivalent wording is acceptable. Never require an item listed under not_required.
- A trap fails the answer only if the final answer endorses it, unretracted, within the question's version or date scope. Quotation, negation, hypothetical discussion, or an explicitly corrected earlier statement does not count.
- Correct JSON never overrides contradictory prose. Evaluate prose and JSON together.
- A null JSON value means uncertainty. If the prose supplies the fact, grade the prose.
- For every field listed in open_fields, decide pass or fail from the prose and JSON.
- answer_correctness: "correct" if the acceptable minimum is met, no central contradiction is endorsed, and no deterministic field failed; "partial" if some required facts are right but the minimum is not met; "incorrect" if a central contradiction is endorsed or the core conclusion is wrong.
- source_support: "supported" if the cited sources are primary, match the named release, version, or date, and their locators would contain support for the material claims, judged against the settling sources; "partial" if some material claims lack a version-matched source or the locators are too vague to check; "unsupported" if material claims rest on no source, the wrong version, or a source that does not say what is claimed. You cannot open URLs. Judge from the settling sources, the citations, and the action list.
- Do not rule on whether retrieval or execution actually happened. That is verified separately from the trace.

Return exactly one JSON object and nothing else, no Markdown fence:
{"grader_id": string, "answer_correctness": "correct"|"partial"|"incorrect", "meets_acceptable_minimum": boolean, "central_contradiction": {"present": boolean, "trap": string|null, "quote": string|null}, "open_fields": {"<field>": "pass"|"fail"}, "judge_criterion": "pass"|"fail", "source_support": "supported"|"partial"|"unsupported", "rationale": string}
Keep the rationale under 120 words and quote the decisive words of the answer when you fail something.`;

export function validate(score: any, graderId: string, openFields: string[]): string[] {
  const errors: string[] = [];
  const oneOf = (value: unknown, allowed: unknown[], name: string) => { if (!allowed.includes(value)) errors.push(`${name} invalid: ${JSON.stringify(value)}`); };
  if (score?.grader_id !== graderId) errors.push('grader_id mismatch');
  oneOf(score?.answer_correctness, ['correct', 'partial', 'incorrect'], 'answer_correctness');
  oneOf(score?.meets_acceptable_minimum, [true, false], 'meets_acceptable_minimum');
  oneOf(score?.central_contradiction?.present, [true, false], 'central_contradiction.present');
  oneOf(score?.judge_criterion, ['pass', 'fail'], 'judge_criterion');
  oneOf(score?.source_support, ['supported', 'partial', 'unsupported'], 'source_support');
  if (typeof score?.rationale !== 'string') errors.push('rationale missing');
  for (const field of openFields) oneOf(score?.open_fields?.[field], ['pass', 'fail'], `open_fields.${field}`);
  return errors;
}

/** The scored pair per case is the latest attempt; superseded attempts are not graded. */
export function scoredRuns() {
  const gold = readJSON(path.join(ROOT, 'bench/gold-round2.json'));
  const runs: any[] = [];
  for (const id of Object.keys(gold.cases)) {
    const dir = fs.readdirSync(DATA).filter((name) => name === `r2-${id}` || name.startsWith(`r2-${id}-a`)).sort().at(-1);
    if (!dir) continue;
    for (const arm of ['E', 'C']) {
      const file = path.join(DATA, dir, arm, 'run.json');
      if (fs.existsSync(file)) runs.push(readJSON(file));
    }
  }
  return { gold, runs };
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await work(queue.shift()!); }));
}

if (process.argv[1] === import.meta.filename) {
  const { gold, runs } = scoredRuns();
  const references = readJSON(path.join(ROOT, 'bench/gold-round2-references.json'));
  const piCli = '/home/jangpi/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const mapping: Record<string, string> = fs.existsSync(path.join(OUT, 'mapping.json')) ? readJSON(path.join(OUT, 'mapping.json')) : {};

  const packets = runs.filter((run) => run.status === 'completed').map((run) => {
    const graderId = `g-${sha(run.runId).slice(0, 12)}`;
    mapping[graderId] = run.runId;
    const entry = gold.cases[run.caseId];
    const deterministic = scoreRun(gold, run);
    const openFields = Object.entries(deterministic.fields).filter(([, verdict]) => verdict === 'judge').map(([field]) => field);
    const packet = {
      grader_id: graderId,
      question_id: run.caseId,
      question: entry.question,
      reference_answer: references.cases[run.caseId].reference_answer,
      settling_sources: references.cases[run.caseId].settling_sources,
      acceptable_minimum: entry.acceptable_minimum,
      not_required: entry.not_required,
      judge_criterion: entry.judge,
      traps: entry.traps,
      deterministic_precheck: deterministic.fields,
      open_fields: openFields,
      answer_under_test: neutralize(run.answer),
      agent_actions: actionList(run.events),
    };
    return { run, graderId, openFields, prompt: `${INSTRUCTIONS}\n\n${JSON.stringify(packet)}` };
  });
  saveJSON(path.join(OUT, 'mapping.json'), mapping);

  await Promise.all(RATERS.map((rater) => pool(packets, CONCURRENCY, async (packet) => {
    const dest = path.join(OUT, `${packet.graderId}.${rater.name}.json`);
    if (fs.existsSync(dest)) return;
    const promptFile = path.join(OUT, `${packet.graderId}.${rater.name}.prompt.txt`);
    fs.writeFileSync(promptFile, packet.prompt, { mode: 0o600 });
    let stdout: string;
    try {
      ({ stdout } = await invoke([piCli, '--provider', rater.provider, '--model', rater.model, '--thinking', rater.thinking, '--print', '--mode', 'json', '--no-session', '--no-tools', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--offline', '--', `@${promptFile}`], OUT));
    } catch (error) {
      saveJSON(`${dest}.error.json`, { rater, error: (error as Error).message.slice(0, 800) });
      return;
    }
    const records = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const message = records.filter((record) => record.type === 'message_end' && record.message?.role === 'assistant').at(-1)?.message;
    const text = message?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') ?? '';
    fs.writeFileSync(`${dest}.txt`, text, { mode: 0o600 });
    let score: any;
    try { score = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { saveJSON(`${dest}.error.json`, { rater, error: 'Non-JSON grader output', stopReason: message?.stopReason, errorMessage: message?.errorMessage }); return; }
    const errors = validate(score, packet.graderId, packet.openFields);
    if (errors.length) { saveJSON(`${dest}.error.json`, { rater, errors, score }); return; }
    saveJSON(dest, { score, rater, usage: message.usage, promptHash: sha(packet.prompt) });
    console.log(JSON.stringify({ rater: rater.name, caseId: packet.run.caseId, correctness: score.answer_correctness, support: score.source_support, reasoning: message.usage?.reasoning ?? null }));
  })));

  const missing = packets.flatMap((packet) => RATERS.filter((rater) => !fs.existsSync(path.join(OUT, `${packet.graderId}.${rater.name}.json`))).map((rater) => `${packet.run.caseId}/${packet.run.arm}/${rater.name}`));
  console.log(JSON.stringify({ graded: packets.length * RATERS.length - missing.length, of: packets.length * RATERS.length, missing }));
}
