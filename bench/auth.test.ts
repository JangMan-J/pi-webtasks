import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideWriteback } from './auth.ts';

test('compare-and-swap writes back only when the host still holds the cloned token', () => {
  assert.equal(decideWriteback('r1', 'r1'), 'written');
  assert.equal(decideWriteback('r1', 'r2'), 'superseded', 'another rotation must never be clobbered');
  assert.equal(decideWriteback('r1', undefined), 'superseded', 'a deleted host entry must not be recreated blindly');
  assert.equal(decideWriteback(undefined, undefined), 'superseded');
  assert.equal(decideWriteback('', ''), 'superseded', 'empty tokens never authorize a write');
});
