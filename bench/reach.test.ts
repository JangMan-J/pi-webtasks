import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactNavigation, fixtureResponse, REACH_CASES, reachStrata, scoreReach } from './reach.ts';
import { artifactStrata, activationDetails } from './ab-tier1-report.ts';

const task = REACH_CASES.find(c => c.id === 'task')!;
const calls = [
  { name: 'parallel_tools', args: { tools: ['parallel_task'] }, index: 0 },
  { name: 'parallel_task', args: { action: 'result', run_id: 'tr_fixture' }, index: 1 },
];
test('routing score requires selected tool, actual operation, ID reuse and answer', () => {
  assert.equal(scoreReach(task, 'lazy', calls, task.answer).pass, true);
  assert.equal(scoreReach(task, 'lazy', calls.slice(0, 1), task.answer).pass, false);
  assert.equal(scoreReach(task, 'lazy', calls.slice(1), task.answer).missedActivation, true);
  assert.equal(scoreReach(task, 'lazy', calls, 'invented').pass, false);
  assert.equal(scoreReach(task, 'lazy', [calls[0], { ...calls[1], args: { action: 'result', run_id: 'wrong' } }], task.answer).pass, false);
  assert.equal(scoreReach(task, 'lazy', calls, task.answer, ['failed']).pass, false);
});
test('routing rejects no-op and excess activation, but direct all-active calls pass', () => {
  assert.equal(scoreReach(task, 'baseline', calls.slice(1), task.answer).pass, true);
  assert.equal(scoreReach(task, 'baseline', calls, task.answer).pass, false);
  assert.equal(scoreReach(task, 'lazy', [calls[0], { ...calls[0], index: 1 }, { ...calls[1], index: 2 }], task.answer).pass, false);
  assert.equal(scoreReach(task, 'lazy', [{ ...calls[0], args: { tools: ['parallel_task', 'parallel_account'] } }, calls[1]], task.answer).pass, false);
  assert.equal(scoreReach(task, 'lazy', [...calls, { name: 'parallel_task', args: { action: 'create' }, index: 2 }], task.answer).forbiddenOperation, true);
});
test('mixed workflow requires core first then the original Task operation', () => {
  const mixed = REACH_CASES.find(c => c.id === 'mixed')!;
  const sequence = [{ name: 'parallel_extract', args: {}, index: 0 }, ...calls.map(c => ({ ...c, index: c.index + 1 }))];
  assert.equal(scoreReach(mixed, 'lazy', sequence, `${task.answer} 2030-02-03`).pass, true);
  assert.equal(scoreReach(mixed, 'lazy', calls, task.answer).pass, false);
});
test('artifact stratum includes failed navigation but not an unrelated shell command', () => {
  assert.equal(artifactNavigation([{ name: 'read', args: { path: '/home/u/.pi/agent/parallelized/results/missing.md' }, index: 0 }]), true);
  assert.equal(artifactNavigation([{ name: 'bash', args: { command: 'ls /home/u/.pi/agent/parallelized/results' }, index: 0 }]), true);
  assert.equal(artifactNavigation([{ name: 'bash', args: { command: 'ls src' }, index: 0 }]), false);
});
test('report keeps artifact pairs together and decodes recorded activation receipts', () => {
  const live = reachStrata([
    { case: 'task', repeat: 0, condition: 'baseline', artifactNavigation: false, cumulativeInputTokens: 100, pass: true },
    { case: 'task', repeat: 0, condition: 'lazy', artifactNavigation: true, cumulativeInputTokens: 50, pass: true },
  ]);
  assert.deepEqual(live.artifactNavigation.map((r: any) => r.n), [1, 1]);
  assert.deepEqual(live.withoutArtifactNavigation.map((r: any) => r.n), [0, 0]);
  const artifact = REACH_CASES.find(c => c.id === 'artifact')!;
  assert.equal(scoreReach(artifact, 'baseline', [{ name: artifact.tool, args: artifact.args, index: 0 }], 'jade-73').output, true);
  const pairs = [
    { baseline: { context: 100, artifactNavigation: false }, lazy: { context: 50, artifactNavigation: false } },
    { baseline: { context: 100, artifactNavigation: false }, lazy: { context: 200, artifactNavigation: true } },
  ];
  const strata = artifactStrata(pairs);
  assert.equal(strata.all.n, 2);
  assert.equal(strata.artifactNavigation.baselineContext, 100);
  assert.equal(strata.withoutArtifactNavigation.lazyContext, 50);
  assert.deepEqual(activationDetails([
    { type: 'tool_call', tool: 'parallel_tools', tool_call_id: 'a', input: { tools: ['parallel_task'] }, requests: 2 },
    { type: 'tool_execution_end', tool_call_id: 'a', output: [{ type: 'text', text: '{"activated":["parallel_task"]}' }] },
    { type: 'tool_call', tool: 'parallel_task', input: { action: 'result', run_id: 'tr_fixture' } },
  ]), [{ requested: ['parallel_task'], activated: ['parallel_task'], requestIndex: 2, nextDeferredTool: 'parallel_task', nextDeferredInput: { action: 'result', run_id: 'tr_fixture' } }]);
});
test('fixture service supports existing resources and fails closed on paid mutations', () => {
  assert.equal(fixtureResponse('GET', '/v1/tasks/runs/tr_fixture/result', {}).status, 200);
  const findall = fixtureResponse('GET', '/v1beta/findall/runs/fa_fixture/result', {}).data as any;
  assert.equal(findall.run.findall_id, 'fa_fixture');
  assert.equal(findall.run.status.status, 'completed');
  assert.equal(findall.run.status.is_active, false);
  assert.equal(fixtureResponse('POST', '/v1beta/memory/retrieve', { memory_scope_key: 'reach_fixture' }).status, 200);
  for (const url of ['/v1/tasks/runs', '/v1beta/findall/runs', '/v1beta/monitors', '/account/service/v1/balance/add']) {
    assert.equal(fixtureResponse('POST', url, {}).status, 400);
  }
});
