#!/usr/bin/env node
/**
 * Failure mining is deterministic and does not leak holdout task names.
 * The fixture under test/fixtures/rsi/mine-input is synthetic.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mineFailures, normalizeCheckOutput } from '../scripts/rsi/mine-failures.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(repoRoot, 'test/fixtures/rsi/mine-input');

function mine() {
  return mineFailures({
    repo: repoRoot,
    results,
    tasksRoot: path.join(repoRoot, 'bench/tasks'),
  });
}

test('check output normalization strips paths and numbers', () => {
  assert.equal(normalizeCheckOutput('expected 1 got 2\n'), 'expected <n> got <n>');
  const normalized = normalizeCheckOutput('fail /tmp/ws/a.js:12\n');
  assert.equal(normalized.includes('/tmp'), false);
  assert.equal(normalized.includes('12'), false);
});

test('fixture mine yields at least 5 signed items and hides holdout tasks', () => {
  const first = mine();
  const second = mine();
  assert.deepEqual(first, second);
  assert.equal(first.synthetic, true);
  assert.ok(first.items.length >= 5, `got ${first.items.length}`);
  const signatures = new Set(first.items.map((item) => item.signature));
  for (const required of [
    'outcome:timedOut',
    'outcome:maxTurns',
    'context:compaction-failed',
    'tool:loop-guard',
    'tool:moss-error:TOOL_EXECUTION_FAILED',
    'taskos:define-without-acceptance',
    'taskos:fail-without-repair',
    'device:falseSuccess',
    'device:policy-denied',
    'knowledge:noGoodMatch',
  ]) {
    assert.equal(signatures.has(required), true, required);
  }
  const stuck = first.items.find((item) => item.signature === 'check:expected <n> got <n>');
  assert.ok(stuck, 'missing normalized check signature');
  assert.equal(stuck.downgraded, true);
  assert.equal(stuck.needsHuman, true);
  const stale = first.items.find((item) => item.signature === 'outcome:exit:7');
  assert.ok(stale);
  assert.equal(stale.score, 0);
  const policy = first.items.find((item) => item.signature === 'device:policy-denied');
  assert.equal(policy.needsHuman, true);
  assert.equal(policy.surface, null);
  assert.deepEqual(first.holdout, [{ category: 'capability', count: 2 }]);
  const encoded = JSON.stringify(first);
  assert.equal(encoded.includes('hidden-holdout-task'), false);
  assert.equal(encoded.includes('secret question text'), false);
  for (const item of first.items) assert.ok(item.examples.length <= 2);
});
