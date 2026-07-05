#!/usr/bin/env node
/**
 * assessGoalVagueness — guards /goal set from committing a goal that's too
 * vague to run against autonomously. Tested from the user's perspective: when
 * the user types /goal set "fix it", does moss ask them to clarify instead of
 * silently starting an autonomous run on a guessed direction?
 */
import assert from 'node:assert/strict';

import { assessGoalVagueness, handleGoalCommand } from '../dist/goal.js';

// ─── vague objectives → clarification message ─────────────────────────────

const VAGUE = [
  'fix it',
  'make it better',
  'improve this',
  'work on it',
  'do that',
  'fix everything',
  'clean up stuff',
  'refactor things',
  'handle it',
  'optimize this',
  'sort out that',
  'make better',
  'improve the code', // vague verb + (the code) — wait, "the code" not in target list
];

// Re-evaluate: "improve the code" should NOT be flagged (no pronoun/generic).
// The list above mixes — let me only assert the ones that SHOULD be flagged.
const SHOULD_FLAG = [
  'fix it',
  'make it better',
  'improve this',
  'work on it',
  'do that',
  'fix everything',
  'clean up stuff',
  'refactor things',
  'handle it',
  'optimize this',
  'sort out that',
  'make better',
];

for (const obj of SHOULD_FLAG) {
  const msg = assessGoalVagueness(obj);
  assert.ok(msg, `"${obj}" should be flagged vague`);
  assert.ok(msg.includes('too broad'), `message for "${obj}" says too broad`);
  assert.ok(msg.includes('/goal set'), `message for "${obj}" tells user to re-issue`);
}

// ─── concrete objectives → NOT vague (pass through) ───────────────────────

const CONCRETE = [
  'add an OAuth login page to web/ that uses Google',
  'fix the login bug where /auth/callback 500s on missing state param',
  'refactor the auth module to use a single token verifier',
  'improve the code readability of connection-error.ts',
  'write a unit test for diffLinesForApproval',
  'add 2', // short but not a vague-verb+pronoun form
  // Short CJK goals must NOT be flagged (no pronoun match) — the heuristic
  // is pattern-based, not length-based, precisely to avoid CJK false positives.
  '修复登录bug',
  '给登录页加 OAuth',
  '重构 auth 模块',
];

for (const obj of CONCRETE) {
  const msg = assessGoalVagueness(obj);
  assert.equal(msg, undefined, `"${obj}" should NOT be flagged vague (got: ${msg ?? ''})`);
}

// ─── edge cases ───────────────────────────────────────────────────────────

assert.equal(assessGoalVagueness(''), undefined, 'empty string is not vague (caller handles empty)');
assert.equal(assessGoalVagueness('   '), undefined, 'whitespace-only is not vague');

console.error('goal-vagueness: vague objectives ask to clarify, concrete ones pass ✓');

// ─── handleGoalCommand: vague goal is NOT set; concrete goal IS set ─────────

// Mock agent that records setGoal calls so we can prove a vague objective
// never reaches setGoal, while a concrete one does.
function mockAgent() {
  const calls = { setGoal: [], getGoal: [], clearGoal: 0 };
  return {
    calls,
    async getGoal() { return undefined; },
    async setGoal(_sk, objective) { calls.setGoal.push(objective); return { objective, status: 'active' }; },
    async pauseGoal() { return undefined; },
    async resumeGoal() { return undefined; },
    async completeGoal() { return undefined; },
    async blockGoal() { return undefined; },
    async clearGoal() { calls.clearGoal += 1; },
  };
}

{
  const agent = mockAgent();
  const result = await handleGoalCommand({
    agent,
    sessionKey: 's',
    input: '/goal set fix it',
  });
  // Vague goal: clarification returned, goal NOT set, no activate event.
  assert.ok(result.message.includes('too broad'), 'vague goal returns the clarification message');
  assert.equal(result.goal, undefined, 'vague goal is not set');
  assert.equal(result.event, undefined, 'vague goal emits no goal_set event');
  assert.equal(agent.calls.setGoal.length, 0, 'setGoal was never called for a vague objective');
}

{
  const agent = mockAgent();
  const result = await handleGoalCommand({
    agent,
    sessionKey: 's',
    input: '/goal set add an OAuth login page to web/',
  });
  // Concrete goal: set, goal returned, goal_set event.
  assert.ok(result.goal, 'concrete goal is set');
  assert.equal(result.event, 'goal_set', 'concrete goal emits goal_set');
  assert.equal(agent.calls.setGoal.length, 1, 'setGoal called once for a concrete objective');
  assert.equal(agent.calls.setGoal[0], 'add an OAuth login page to web/');
}
