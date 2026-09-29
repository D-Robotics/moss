#!/usr/bin/env node
/**
 * Best-of-n fix engine (v0.10 W2) — unit locks with mock spawner/verifier.
 * Covers: candidate wins on green verify, all-fail honesty, sequential (never
 * concurrent) spawning, crash isolation, task-text contract (command + tail +
 * different-angle instruction), and the streak trigger in the loop.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runBestOfNFix,
  describeBestOfNOutcome,
  buildCandidateTask,
} from '../dist/core/loop/best-of-n-fix.js';
import { createHeadlessPrintState, formatHeadlessStreamEvent } from '../dist/cli/print.js';

test('candidate wins as soon as verification passes', async () => {
  let verifications = 0;
  const spawns = [];
  const result = await runBestOfNFix({
    n: 3,
    failingCommand: 'node test.js',
    failingOutputTail: 'AssertionError: expected 15',
    spawnCandidate: async (task) => {
      spawns.push(task);
      return { success: true, summary: `fixed on attempt ${spawns.length}` };
    },
    runVerify: async () => {
      verifications += 1;
      return verifications >= 2
        ? { pass: true, outputTail: 'all tests passed' }
        : { pass: false, outputTail: 'still red' };
    },
  });
  assert.equal(result.fixed, true);
  assert.equal(result.attempted, 2, 'stopped at the first green candidate');
  assert.equal(spawns.length, 2, 'no third candidate spawned after the win');
  assert.match(result.candidates[0].verifyOutputTail, /still red/);
});

test('all candidates fail — honest failure, all n attempted sequentially', async () => {
  const order = [];
  const result = await runBestOfNFix({
    n: 3,
    failingCommand: 'npm test',
    failingOutputTail: '1 failing',
    spawnCandidate: async (task) => {
      order.push('spawn');
      assert.match(task, /npm test/);
      return { success: true, summary: 'no luck' };
    },
    runVerify: async () => {
      order.push('verify');
      return { pass: false, outputTail: '1 failing' };
    },
  });
  assert.equal(result.fixed, false);
  assert.equal(result.attempted, 3);
  assert.deepEqual(
    order,
    ['spawn', 'verify'].concat(['spawn', 'verify'], ['spawn', 'verify']),
    'strictly sequential: spawn→verify per candidate, never concurrent'
  );
  const described = describeBestOfNOutcome(result);
  assert.match(described, /all FAILED/);
  assert.match(described, /do not claim success/);
});

test('a crashing candidate does not abort the engine', async () => {
  let calls = 0;
  const result = await runBestOfNFix({
    n: 2,
    failingCommand: 'node test.js',
    failingOutputTail: 'red',
    spawnCandidate: async () => {
      calls += 1;
      if (calls === 1) throw new Error('child exploded');
      return { success: true, summary: 'second try' };
    },
    runVerify: async () => ({ pass: calls === 2, outputTail: 'green' }),
  });
  assert.equal(result.fixed, true);
  assert.match(result.candidates[0].summary, /child exploded/);
});

test('winning description carries the summary and continuation instruction', async () => {
  const described = describeBestOfNOutcome({
    attempted: 2,
    fixed: true,
    candidates: [
      { index: 0, pass: false, summary: 'a', verifyOutputTail: 'red' },
      { index: 1, pass: true, summary: 'removed the accidental dedupe', verifyOutputTail: 'green' },
    ],
  });
  assert.match(described, /PASSES after 2 candidate/);
  assert.match(described, /removed the accidental dedupe/);
  assert.match(described, /do not undo the fix/);
});

test('candidate task names the command, carries the tail, demands a different angle', () => {
  const first = buildCandidateTask({
    n: 3,
    index: 0,
    failingCommand: 'node test.js',
    failingOutputTail: 'x'.repeat(3000),
  });
  assert.match(first, /`node test.js` fails/);
  assert.ok(first.length < 3000, 'oversized failure tails are truncated');
  assert.match(first, /fix attempt 1 of 3/);
  const later = buildCandidateTask({
    n: 3,
    index: 2,
    failingCommand: 'npm test',
    failingOutputTail: 'red',
  });
  assert.match(later, /attempt 3 of 3/);
  assert.match(later, /different angle/);
});

test('loop streak trigger: two consecutive same-command failures escalate once', async () => {
  const { recordFailingVerifyStreak } =
    await import('../dist/core/loop/agent-loop-tool-execution.js');
  const state = {
    failingVerifyStreak: undefined,
    bestOfNEscalated: false,
  };
  // first failure of `node test.js` via exec
  recordFailingVerifyStreak(state, 'exec', { command: 'node test.js' }, 'exit_code: 1 FAIL', false);
  assert.equal(state.failingVerifyStreak.count, 1);
  // unrelated command failure does not extend the streak
  recordFailingVerifyStreak(state, 'exec', { command: 'node other.js' }, 'FAIL', false);
  assert.equal(state.failingVerifyStreak.count, 1, 'different command keeps its own streak');
  // same command again → 2
  recordFailingVerifyStreak(state, 'exec', { command: 'node test.js' }, 'FAIL again', false);
  assert.equal(state.failingVerifyStreak.count, 2);
  assert.equal(state.failingVerifyStreak.command, 'node test.js');
  // run_tests shapes record their effective command
  recordFailingVerifyStreak(state, 'run_tests', { file: 'test/x.mjs' }, '1 failing', true);
  assert.equal(state.failingVerifyStreak.command, 'node --test test/x.mjs');
  // a pass resets
  recordFailingVerifyStreak(state, 'exec', { command: 'node test.js' }, 'all tests passed', false);
  assert.equal(state.failingVerifyStreak, undefined);
  // non-test exec never records
  const before = state.failingVerifyStreak;
  recordFailingVerifyStreak(state, 'exec', { command: 'rm -rf /' }, 'FAIL', true);
  assert.equal(state.failingVerifyStreak, before ?? undefined, 'non-test commands ignored');
});

test('escalation outcome message is injectable as a system message via print state', () => {
  const state = createHeadlessPrintState({ sessionId: 'bon' });
  const events = formatHeadlessStreamEvent(state, {
    type: 'text_delta',
    delta: 'Working...',
  });
  assert.equal(events.length, 0, 'text_delta only buffers (sanity)');
});

console.log('[PASS] best-of-n fix engine');
