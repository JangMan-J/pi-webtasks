import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellRoute, routeAttribution, extractJsonTail } from './r2-run.ts';

test('shell commands are attributed to exactly one route', () => {
  assert.equal(shellRoute("parallel-cli extract 'https://docs.litellm.ai/docs/completion/input'"), 'cli', 'a CLI call with a URL argument is the interface, not a bypass');
  assert.equal(shellRoute('parallel-research "question"'), 'cli');
  assert.equal(shellRoute('npx ctx7@latest docs /berriai/litellm "query"'), 'context7');
  assert.equal(shellRoute('curl -sL https://github.com/x/y'), 'direct');
  assert.equal(shellRoute('git clone --depth 1 https://github.com/x/y.git'), 'direct');
  assert.equal(shellRoute("python - <<'PY'\nimport urllib.request\nPY"), 'direct');
  assert.equal(shellRoute('grep -n foo /tmp/bar.py'), 'other');
});

test('route attribution separates gateway, CLI, Context7, and direct counts', () => {
  const call = (command: string) => ({ type: 'tool_call', tool: 'bash', input: { command } });
  const route = routeAttribution([
    { type: 'gateway_request', path: '/v1/extract' },
    call("parallel-cli extract 'https://a'"),
    call('npx ctx7@latest library X q'),
    call('curl https://b'),
    call('ls'),
  ]);
  assert.equal(route.interfaceDispatches, 1);
  assert.equal(route.cliInterfaceCalls, 1);
  assert.equal(route.context7Calls, 1);
  assert.equal(route.directHttpCalls, 1);
});

test('the final fenced JSON block is the structured answer', () => {
  const answer = 'prose\n```json\n{"a":1}\n```\nmore\n```json\n{"question_id":"Q4"}\n```';
  assert.deepEqual(extractJsonTail(answer)?.json, { question_id: 'Q4' });
  assert.equal(extractJsonTail('no json here'), null);
  assert.equal(extractJsonTail('```json\n{broken\n```'), null);
});
