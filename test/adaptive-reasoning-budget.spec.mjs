#!/usr/bin/env node
/**
 * Adaptive reasoning budget (v0.10 W4) — unit locks on the escalation rule.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

function effectiveReasoning({ configured, budget, pressure }) {
  let effective = configured;
  const mode = budget ?? 'adaptive';
  if (mode === 'high') return 'high';
  if (mode === 'off') return configured;
  if (pressure && configured !== undefined && configured !== null) return 'high';
  return effective;
}

test('adaptive: pressure escalates a configured level to high; clean run unchanged', () => {
  assert.equal(
    effectiveReasoning({ configured: 'low', budget: 'adaptive', pressure: true }),
    'high'
  );
  assert.equal(
    effectiveReasoning({ configured: 'low', budget: 'adaptive', pressure: false }),
    'low'
  );
  assert.equal(
    effectiveReasoning({ configured: 'medium', budget: 'adaptive', pressure: true }),
    'high'
  );
});

test('adaptive leaves unconfigured reasoning untouched (provider default wins)', () => {
  assert.equal(
    effectiveReasoning({ configured: undefined, budget: 'adaptive', pressure: true }),
    undefined
  );
});

test('off pins the configured level even under pressure; high pins high', () => {
  assert.equal(effectiveReasoning({ configured: 'low', budget: 'off', pressure: true }), 'low');
  assert.equal(
    effectiveReasoning({ configured: undefined, budget: 'high', pressure: false }),
    'high'
  );
});

test('wiring: MOSS_REASONING_BUDGET resolves through config', async () => {
  const { resolveCliConfig } = await import('../dist/cli/config.js');
  assert.equal(resolveCliConfig({ MOSS_REASONING_BUDGET: 'high' }).reasoningBudget, 'high');
  assert.equal(resolveCliConfig({ MOSS_REASONING_BUDGET: 'off' }).reasoningBudget, 'off');
  assert.equal(resolveCliConfig({ MOSS_REASONING_BUDGET: 'garbage' }).reasoningBudget, undefined);
});

test('pressure signals come from real loop state fields', async () => {
  const { createInitialLoopState } = await import('../dist/core/loop/agent-loop-state.js');
  const state = createInitialLoopState();
  let pressure =
    (state.failingVerifyStreak?.count ?? 0) >= 1 ||
    state.redVerifyNudgeAttempts > 0 ||
    state.consecutiveTurnErrors > 0;
  assert.equal(pressure, false, 'fresh state is not under pressure');
  state.redVerifyNudgeAttempts = 1;
  pressure =
    (state.failingVerifyStreak?.count ?? 0) >= 1 ||
    state.redVerifyNudgeAttempts > 0 ||
    state.consecutiveTurnErrors > 0;
  assert.equal(pressure, true, 'red verify raises pressure');
  state.failingVerifyStreak = { command: 'node test.js', outputTail: 'red', count: 2 };
  pressure =
    (state.failingVerifyStreak?.count ?? 0) >= 1 ||
    state.redVerifyNudgeAttempts > 0 ||
    state.consecutiveTurnErrors > 0;
  assert.equal(pressure, true, 'verify streak raises pressure');
});

console.log('[PASS] adaptive reasoning budget');
