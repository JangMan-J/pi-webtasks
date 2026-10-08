/**
 * Grader calibration. A grader that rates everything "correct" is
 * uninformative, so before trusting a unanimous pass, check that each grader
 * fails a planted trap and passes a trap that is only mentioned to be rejected.
 *
 * Each probe takes a real graded answer and inserts one sentence into the
 * prose conclusion, immediately before the JSON block. The JSON is left
 * correct, so a grader must apply "correct JSON never overrides contradictory
 * prose" to catch it. The same packet builder and instructions as the real
 * pass are used; only the answer differs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, saveJSON, sha } from './core.ts';
import { scoreRun } from './r2-score.ts';
import { RATERS, INSTRUCTIONS, PI_CLI, invoke, neutralize, actionList, validate, scoredRuns } from './r2-grade.ts';

const PROBES = [
  { id: 'cal-q4-trap', caseId: 'Q4', arm: 'E', expect: 'fail', plant: 'In summary, the graph UI can invoke three tools through POST /rpc: `list_projects`, `get_graph_schema`, and `get_code_snippet`.' },
  { id: 'cal-q5-trap', caseId: 'Q5', arm: 'E', expect: 'fail', plant: 'In summary, if bubblewrap setup fails, Codex 0.154.0 automatically falls back to the legacy Landlock backend, so no opt-in is needed.' },
  { id: 'cal-q8-trap', caseId: 'Q8', arm: 'E', expect: 'fail', plant: 'In summary, any field omitted from `get_supported_openai_params()` is rejected by the upstream provider.' },
  { id: 'cal-q4-rejected', caseId: 'Q4', arm: 'C', expect: 'pass', plant: 'A common misreading is that this route exposes three tools including `get_graph_schema`; that is wrong for v0.10.8, where only the two tools above are allowed.' },
] as const;

function plantBeforeJson(answer: string, sentence: string): string {
  const at = answer.lastIndexOf('```json');
  return at < 0 ? `${answer}\n\n${sentence}` : `${answer.slice(0, at)}${sentence}\n\n${answer.slice(at)}`;
}

if (process.argv[1] === import.meta.filename) {
  const { gold, runs } = scoredRuns();
  const references = readJSON(path.join(ROOT, 'bench/gold-round2-references.json'));
  const out = path.join(ROOT, '.pi/benchmark/data/grading/r2-calibration');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const results: any[] = [];

  await Promise.all(PROBES.flatMap((probe) => RATERS.map(async (rater) => {
    const run = runs.find((candidate) => candidate.caseId === probe.caseId && candidate.arm === probe.arm && candidate.status === 'completed');
    if (!run) { results.push({ probe: probe.id, rater: rater.name, error: 'source run missing' }); return; }
    const entry = gold.cases[probe.caseId];
    const deterministic = scoreRun(gold, run);
    const openFields = Object.entries(deterministic.fields).filter(([, verdict]) => verdict === 'judge').map(([field]) => field);
    const graderId = `g-${sha(probe.id).slice(0, 12)}`;
    const packet = {
      grader_id: graderId,
      question_id: probe.caseId,
      question: entry.question,
      reference_answer: references.cases[probe.caseId].reference_answer,
      settling_sources: references.cases[probe.caseId].settling_sources,
      acceptable_minimum: entry.acceptable_minimum,
      not_required: entry.not_required,
      judge_criterion: entry.judge,
      traps: entry.traps,
      deterministic_precheck: deterministic.fields,
      open_fields: openFields,
      answer_under_test: neutralize(plantBeforeJson(run.answer, probe.plant)),
      agent_actions: actionList(run.events),
    };
    const promptFile = path.join(out, `${probe.id}.${rater.name}.prompt.txt`);
    fs.writeFileSync(promptFile, `${INSTRUCTIONS}\n\n${JSON.stringify(packet)}`, { mode: 0o600 });
    try {
      const { stdout } = await invoke([PI_CLI, '--provider', rater.provider, '--model', rater.model, '--thinking', rater.thinking, '--print', '--mode', 'json', '--no-session', '--no-tools', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--offline', '--', `@${promptFile}`], out);
      const message = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
        .filter((record) => record.type === 'message_end' && record.message?.role === 'assistant').at(-1)?.message;
      const text = message?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') ?? '';
      const score = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      const errors = validate(score, graderId, openFields);
      const failed = score.answer_correctness !== 'correct' || score.central_contradiction?.present === true;
      results.push({ probe: probe.id, rater: rater.name, expect: probe.expect, got: failed ? 'fail' : 'pass', correct: (failed ? 'fail' : 'pass') === probe.expect, correctness: score.answer_correctness, contradiction: score.central_contradiction, schemaErrors: errors });
    } catch (error) {
      results.push({ probe: probe.id, rater: rater.name, error: (error as Error).message.slice(0, 200) });
    }
  })));

  saveJSON(path.join(out, 'results.json'), results);
  for (const result of results.sort((a, b) => `${a.probe}${a.rater}`.localeCompare(`${b.probe}${b.rater}`))) {
    console.log(result.error
      ? `${result.probe.padEnd(16)} ${result.rater}  ERROR ${result.error}`
      : `${result.probe.padEnd(16)} ${result.rater}  expect ${result.expect}  got ${result.got}  ${result.correct ? 'OK' : 'MISS'}  (${result.correctness}; quote: ${JSON.stringify(result.contradiction?.quote ?? null).slice(0, 90)})`);
  }
  const scored = results.filter((result) => !result.error);
  console.log(`\ncalibration: ${scored.filter((result) => result.correct).length} of ${scored.length} probes graded as expected`);
}
