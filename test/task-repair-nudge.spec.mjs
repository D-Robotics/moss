#!/usr/bin/env node
/**
 * TaskRepairNudge unit spec (red→green): after a red task_acceptance verdict
 * the agent gets the exact repair-loop discipline (hypothesis-first,
 * record_failure → fix → record_repair → evidence → re-accept); after a
 * re-fail with a repair already on record it is told NOT to repeat that
 * repair. No task_acceptance activity → the nudge stays silent.
 */
import assert from 'node:assert/strict';
import { evaluateTaskRepairNudge } from '../dist/core/loop/nudges/task-repair-nudge.js';

const FAIL_VERDICT = [
  'Task acceptance (task_1): FAIL',
  'goal: bring monitor back into SLA',
  '  [NO EVIDENCE] verify_exit_code — expected ==0',
  'criteria: 0/2 met (2 required unmet), evidence records considered: 0',
  'FINAL: not accepted — record evidence for the missing metrics (record_evidence with task_id), repair what failed, then re-run task_acceptance.',
].join('\n');

const PASS_VERDICT = [
  'Task acceptance (task_1): PASS',
  '  [PASS] verify_exit_code — expected ==0 observed 0',
  'FINAL: PASS — acceptance criteria met with recorded evidence.',
].join('\n');

function toolUse(id, name, input = {}) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function toolResult(id, name, text) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, name, content: text }],
  };
}

// 1. No task_acceptance activity → never fires (zero noise for plain runs).
{
  const r = evaluateTaskRepairNudge({
    messages: [{ role: 'user', content: 'fix the bug' }, toolUse('t1', 'exec', { command: 'ls' })],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// 2. Latest task_acceptance FAIL, no repair-path activity after → fire with
//    the full loop discipline, hypothesis first.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      { role: 'user', content: 'repair the monitor' },
      toolUse('acc1', 'task_acceptance', {}),
      toolResult('acc1', 'task_acceptance', FAIL_VERDICT),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /record_failure/);
  assert.match(r.correction, /record_repair/);
  assert.match(r.correction, /record_evidence/);
  assert.match(r.correction, /task_acceptance/);
  assert.match(r.correction, /root[- ]cause/i);
  // First fail: this is not (yet) a repeat-repair situation.
  assert.doesNotMatch(r.correction, /do not repeat/i);
}

// 3. FAIL then repair-path tool_use after it (record_failure) → silent.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      { role: 'user', content: 'repair the monitor' },
      toolUse('acc1', 'task_acceptance', {}),
      toolResult('acc1', 'task_acceptance', FAIL_VERDICT),
      toolUse('f1', 'record_failure', { task_id: 'task_1', symptom: 'oracle exits 1' }),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// 4. Re-fail with a record_repair BEFORE the verdict → anti-repeat variant.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      { role: 'user', content: 'repair the monitor' },
      toolUse('f1', 'record_failure', { task_id: 'task_1', symptom: 'oracle exits 1' }),
      toolUse('rep1', 'record_repair', { task_id: 'task_1', action: 'raise batch size' }),
      toolUse('acc1', 'task_acceptance', {}),
      toolResult('acc1', 'task_acceptance', FAIL_VERDICT),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /do not repeat/i);
  assert.match(r.correction, /different root-cause hypothesis/i);
}

// 5. Attempt cap (2 per red wave) → silent.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('acc1', 'task_acceptance', {}),
      toolResult('acc1', 'task_acceptance', FAIL_VERDICT),
    ],
    attempts: 2,
  });
  assert.equal(r.fire, false);
}

// 6. Latest verdict is PASS → silent, and the counter resets so a later
//    red wave can fire again.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('acc1', 'task_acceptance', {}),
      toolResult('acc1', 'task_acceptance', FAIL_VERDICT),
      toolUse('rep1', 'record_repair', { task_id: 'task_1', action: 'raise batch size' }),
      toolUse('acc2', 'task_acceptance', {}),
      toolResult('acc2', 'task_acceptance', PASS_VERDICT),
    ],
    attempts: 2,
  });
  assert.equal(r.fire, false);
  assert.equal(r.resetAttempts, true);
}

// 7. Tool names resolved via the assistant tool_use id when the result
//    block carries no name (provider-agnostic pairing).
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('acc1', 'task_acceptance', {}),
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'acc1', content: FAIL_VERDICT }],
      },
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true);
}

console.log('task-repair-nudge.spec: all assertions passed');
