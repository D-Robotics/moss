#!/usr/bin/env node
/**
 * Deterministic probe for the plan-mode end protocol (backlog B04).
 *
 * The baseline proved the gap: `moss --plan -p "Read package.json and tell me
 * the project name."` reads the file and ends with prose — zero `exit_plan`
 * calls — so there is no approvable plan version. These checks pin the prompt
 * contract, the evaluation rule, and the hold-once behaviour of the gate.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const gate = await import(
  pathToFileURL(path.join(root, 'dist/core/loop/plan-completion-gate.js')).href
);
const prompt = await import(
  pathToFileURL(path.join(root, 'dist/contracts/prompts/plan-mode-prompt.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[plan-end] ok ${name}`);
}

function assistantToolUse(name, id) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
    timestamp: 1,
  };
}
function toolResult(id, name, content, isError = false) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, name, content, is_error: isError }],
    timestamp: 2,
  };
}
function request(messages, totalToolCalls) {
  return { messages, totalToolCalls };
}

// ── 1. The prompt states the contract ──────────────────────────────────────

assert.ok(prompt.PLAN_MODE_PROMPT.includes('exit_plan'));
assert.ok(/End the turn with/.test(prompt.PLAN_MODE_PROMPT));
assert.ok(/shall I proceed/.test(prompt.PLAN_MODE_PROMPT));
ok('plan prompt requires ending with exit_plan');

// ── 2. Evaluation rule ─────────────────────────────────────────────────────

const exploreThenProse = request(
  [assistantToolUse('read_file', 't1'), toolResult('t1', 'read_file', '{"name":"demo"}')],
  1
);
const missed = gate.evaluatePlanEndProtocol(exploreThenProse, true);
assert.equal(missed.ok, false);
assert.ok(missed.correction.includes('exit_plan'));
ok('tool work without exit_plan is held');

assert.equal(gate.evaluatePlanEndProtocol(exploreThenProse, false).ok, true);
assert.equal(gate.evaluatePlanEndProtocol(request([], 0), true).ok, true);
ok('outside plan mode, or with no tool work, nothing is held');

const submitted = request(
  [
    assistantToolUse('read_file', 't1'),
    toolResult('t1', 'read_file', '{"name":"demo"}'),
    assistantToolUse('exit_plan', 't2'),
    toolResult('t2', 'exit_plan', 'Plan submitted for approval (version abc123).'),
  ],
  2
);
assert.equal(gate.evaluatePlanEndProtocol(submitted, true).ok, true);
ok('a submitted exit_plan satisfies the contract');

const failedSubmit = request(
  [
    assistantToolUse('exit_plan', 't1'),
    toolResult('t1', 'exit_plan', 'Error: exit_plan requires a summary of the plan.', true),
  ],
  1
);
assert.equal(gate.evaluatePlanEndProtocol(failedSubmit, true).ok, false);
ok('a failed exit_plan does not count as submitted');

const asked = request(
  [
    assistantToolUse('read_file', 't1'),
    toolResult('t1', 'read_file', 'x'),
    assistantToolUse('ask_user_question', 't2'),
    toolResult('t2', 'ask_user_question', 'user chose option A'),
  ],
  2
);
assert.equal(gate.evaluatePlanEndProtocol(asked, true).ok, true);
ok('ending with a concrete question is allowed');

// ── 3. The gate is bounded to one hold per run ─────────────────────────────

let planMode = true;
const completionGate = gate.createPlanCompletionGate({ planModeActive: () => planMode });
const first = await completionGate(exploreThenProse);
assert.equal(first.ok, false);
assert.ok(first.correction.includes('exit_plan'));
assert.equal(first.retryLimit >= 1, true);
const second = await completionGate(exploreThenProse);
assert.equal(second.ok, true, 'a second hold would loop the run');
ok('the gate holds at most once per run');

planMode = false;
const outsidePlan = await gate.createPlanCompletionGate({ planModeActive: () => planMode })(
  exploreThenProse
);
assert.equal(outsidePlan.ok, true);
ok('nothing happens outside plan mode');

console.log(`[plan-end] PASS (${checks} checks)`);
