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

// --- multi-task sessions -----------------------------------------------------

function verdictText(taskId, outcome) {
  const head = 'Task acceptance (' + taskId + '): ' + outcome;
  if (outcome === 'PASS') {
    return (
      head +
      '\n  [PASS] m — expected ==0 observed 0\nFINAL: PASS — acceptance criteria met with recorded evidence.'
    );
  }
  return (
    head +
    '\n  [NO EVIDENCE] m — expected ==0\ncriteria: 0/1 met (1 required unmet), evidence records considered: 0\nFINAL: not accepted — record evidence for the missing metrics, repair what failed, then re-run task_acceptance.'
  );
}

// 8. REGRESSION (red→green): a FAIL verdict on task B must NOT be masked by
//    a later PASS verdict on task A — the nudge tracks the latest verdict
//    PER TASK, so B's pending repair still gets guidance (and the correction
//    names the task that failed).
{
  const r = evaluateTaskRepairNudge({
    messages: [
      { role: 'user', content: 'two tasks' },
      toolUse('accB', 'task_acceptance', { task_id: 'task_B' }),
      toolResult('accB', 'task_acceptance', verdictText('task_B', 'FAIL')),
      toolUse('accA', 'task_acceptance', { task_id: 'task_A' }),
      toolResult('accA', 'task_acceptance', verdictText('task_A', 'PASS')),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /task_B/);
  assert.doesNotMatch(r.correction, /task_A/);
}

// 9. REGRESSION (red→green): repair work belonging to task A does not count
//    as progress on task B's pending FAIL (per-task activity attribution via
//    the tools' task_id input).
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('accB', 'task_acceptance', { task_id: 'task_B' }),
      toolResult('accB', 'task_acceptance', verdictText('task_B', 'FAIL')),
      toolUse('repA', 'record_repair', { task_id: 'task_A', action: 'fix A' }),
      toolUse('accA', 'task_acceptance', { task_id: 'task_A' }),
      toolResult('accA', 'task_acceptance', verdictText('task_A', 'PASS')),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /task_B/);
}

// 10. Per-task suppression: repair work FOR task B after its FAIL keeps the
//     nudge silent (same as case 3, but with explicit task_id attribution).
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('accB', 'task_acceptance', { task_id: 'task_B' }),
      toolResult('accB', 'task_acceptance', verdictText('task_B', 'FAIL')),
      toolUse('fB', 'record_failure', { task_id: 'task_B', symptom: 'x' }),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// 11. KNOWN-LIMITATION LOCK: a bare record_evidence after the FAIL silences
//     the nudge (evidence is repair-path progress by design — latest evidence
//     per metric wins, so fresh evidence may legitimately clear the verdict).
//     If this behavior is ever changed deliberately, update this lock first.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('acc1', 'task_acceptance', { task_id: 'task_1' }),
      toolResult('acc1', 'task_acceptance', FAIL_VERDICT),
      toolUse('ev1', 'record_evidence', { task_id: 'task_1', metric: 'm', observed: 0 }),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// 12. KNOWN-LIMITATION LOCK: a PARTIAL verdict (optional criteria unmet) is
//     not a red wave — no fire, and no counter reset either.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('acc1', 'task_acceptance', { task_id: 'task_1' }),
      toolResult(
        'acc1',
        'task_acceptance',
        'Task acceptance (task_1): PARTIAL\n  [PASS] m1 — expected ==0 observed 0\n  [FAIL] m2 — expected >=1 (optional)\nFINAL: not accepted.'
      ),
    ],
    attempts: 1,
  });
  assert.equal(r.fire, false);
  assert.notEqual(r.resetAttempts, true);
}

// 13. REGRESSION (adversarial-review follow-up): an UNATTRIBUTED
//     task_acceptance call (tool schema allows omitting task_id — it resolves
//     to the latest task, here task_A) must not count as repair progress for
//     task_B and silence its pending FAIL.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('accB', 'task_acceptance', { task_id: 'task_B' }),
      toolResult('accB', 'task_acceptance', verdictText('task_B', 'FAIL')),
      toolUse('accAnon', 'task_acceptance', {}),
      toolResult('accAnon', 'task_acceptance', verdictText('task_A', 'PASS')),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true, 'task_B still waits on repair');
  assert.match(r.correction, /task_B/);
}

// 14. The same unattributed acceptance must not silence the wave when it is a
//     FAIL re-run either: the verdict text (not the call input) is the truth.
{
  const r = evaluateTaskRepairNudge({
    messages: [
      toolUse('accB', 'task_acceptance', { task_id: 'task_B' }),
      toolResult('accB', 'task_acceptance', verdictText('task_B', 'FAIL')),
      toolUse('accAnon', 'task_acceptance', {}),
      toolResult('accAnon', 'task_acceptance', verdictText('task_B', 'FAIL')),
    ],
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /task_B/);
}

console.log('task-repair-nudge.spec: all assertions passed');
