#!/usr/bin/env node
/**
 * Task runtime contract (Task OS M1): event-driven phase machine — happy
 * path, repair cycle, guards (no self-claimed acceptance, terminal phases
 * immutable), info events, blocked/unblocked with resume target.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_PHASES,
  isTerminalTaskPhase,
  taskStatusView,
  deriveTaskOutcome,
  nextTaskPhase,
  formatTaskPhase,
  formatFailureRecord,
} from '../dist/contracts/task-runtime.js';

const t = (phase, event, resumePhase) => nextTaskPhase(phase, event, resumePhase);

test('happy path: draft -> understanding -> planning -> ready -> executing -> verifying -> accepted', () => {
  let phase = 'draft';
  phase = t(phase, 'task_understood');
  assert.equal(phase, 'understanding');
  phase = t(phase, 'planning_started');
  assert.equal(phase, 'planning');
  phase = t(phase, 'plan_ready');
  assert.equal(phase, 'ready');
  phase = t(phase, 'execution_started');
  assert.equal(phase, 'executing');
  phase = t(phase, 'verification_started');
  assert.equal(phase, 'verifying');
  phase = t(phase, 'acceptance_pass');
  assert.equal(phase, 'accepted');
});

// Regression (caught live in bench task-os-a): plan_ready from draft is the
// agent-created-task path (task_define emits task_created + plan_ready back
// to back) — the table once value-shifted this cell to 'understanding'.
test('plan_ready lands on ready from every planning-adjacent phase', () => {
  assert.equal(t('draft', 'plan_ready'), 'ready');
  assert.equal(t('understanding', 'plan_ready'), 'ready');
  assert.equal(t('planning', 'plan_ready'), 'ready');
  assert.equal(t('executing', 'plan_ready'), null);
});

// Structural guard (value-shift typos hit this table twice): every
// transition target must be a declared phase. A shifted row like
// plan_ready: {draft: 'understanding'} passes column checks but fails
// nothing here unless the target is invalid — so also pin the semantics
// of every row's targets set below.
test('transition table invariants: targets are valid phases; key rows pinned', async () => {
  const { nextTaskPhase } = await import('../dist/contracts/task-runtime.js');
  const events = [
    'task_understood',
    'planning_started',
    'plan_ready',
    'execution_started',
    'verification_started',
    'verification_failed',
    'acceptance_pass',
    'acceptance_fail',
    'diagnosis_recorded',
    'repair_applied',
    'blocked_on_user',
    'unblocked',
    'task_failed',
    'task_abandoned',
    'task_resumed',
  ];
  const semantics = {
    task_understood: new Set(['understanding']),
    planning_started: new Set(['planning']),
    plan_ready: new Set(['ready']),
    execution_started: new Set(['executing']),
    verification_started: new Set(['verifying', 'reverifying']),
    verification_failed: new Set(['diagnosing']),
    acceptance_pass: new Set(['accepted']),
    acceptance_fail: new Set(['diagnosing']),
    repair_applied: new Set(['repairing']),
    blocked_on_user: new Set(['blocked']),
    unblocked: new Set([
      /* resume target varies */
    ]),
    task_failed: new Set(['failed']),
    task_abandoned: new Set(['abandoned']),
    task_resumed: new Set(['executing']),
  };
  for (const event of events) {
    const allowed = semantics[event];
    if (!allowed || allowed.size === 0) continue;
    for (const phase of TASK_PHASES) {
      const next = nextTaskPhase(phase, event);
      if (next !== null) {
        assert.ok(TASK_PHASES.includes(next), `${event} from ${phase} → invalid phase ${next}`);
        assert.ok(
          allowed.has(next) || (event === 'unblocked' && !isTerminalTaskPhase(next)),
          `${event} from ${phase} → ${next} outside pinned semantics ${[...allowed]}`
        );
      }
    }
  }
});

test('repair cycle: fail -> diagnosing -> repairing -> reverifying -> pass', () => {
  let phase = 'verifying';
  phase = t(phase, 'acceptance_fail');
  assert.equal(phase, 'diagnosing');
  phase = t(phase, 'diagnosis_recorded');
  assert.equal(phase, 'diagnosing');
  phase = t(phase, 'repair_applied');
  assert.equal(phase, 'repairing');
  phase = t(phase, 'verification_started');
  assert.equal(phase, 'reverifying');
  phase = t(phase, 'verification_failed');
  assert.equal(phase, 'diagnosing');
  phase = t(phase, 'repair_applied');
  assert.equal(phase, 'repairing');
  phase = t(phase, 'verification_started');
  assert.equal(phase, 'reverifying');
  phase = t(phase, 'acceptance_pass');
  assert.equal(phase, 'accepted');
});

test('guard: acceptance can never be granted outside a verification phase', () => {
  assert.equal(t('executing', 'acceptance_pass'), null);
  assert.equal(t('diagnosing', 'acceptance_pass'), null);
  assert.equal(t('repairing', 'acceptance_pass'), null);
  assert.equal(t('draft', 'acceptance_pass'), null);
});

test('guard: terminal phases are immutable except explicit resume', () => {
  for (const terminal of ['accepted', 'failed', 'abandoned']) {
    assert.ok(isTerminalTaskPhase(terminal));
    for (const event of ['task_understood', 'execution_started', 'acceptance_pass', 'note']) {
      assert.equal(t(terminal, event), null, `${terminal} + ${event} must be invalid`);
    }
  }
  // accepted is final: resume means a new task, not mutating the record
  assert.equal(t('accepted', 'task_resumed'), null);
});

test('guard: unknown event/phase combinations are rejected, not guessed', () => {
  assert.equal(t('draft', 'repair_applied'), null);
  assert.equal(t('ready', 'diagnosis_recorded'), null);
  assert.equal(t('understanding', 'verification_started'), null);
  assert.equal(t('planning', 'verification_failed'), null);
});

test('info events keep the phase but stay valid on any live phase', () => {
  for (const phase of ['draft', 'executing', 'verifying', 'repairing']) {
    assert.equal(t(phase, 'evidence_recorded'), phase);
    assert.equal(t(phase, 'plan_step_updated'), phase);
    assert.equal(t(phase, 'deployment_recorded'), phase);
    assert.equal(t(phase, 'note'), phase);
    assert.equal(t(phase, 'task_created'), phase);
  }
});

test('blocked_on_user from any live phase; unblocked returns to resume target', () => {
  for (const phase of ['draft', 'planning', 'executing', 'verifying']) {
    assert.equal(t(phase, 'blocked_on_user'), 'blocked');
  }
  assert.equal(t('blocked', 'unblocked'), 'executing');
  assert.equal(t('blocked', 'unblocked', 'planning'), 'planning');
  assert.equal(t('blocked', 'unblocked', 'accepted'), null);
  assert.equal(t('blocked', 'unblocked', 'bogus'), null);
});

test('task_failed and task_abandoned from live phases; task_resumed re-enters executing', () => {
  assert.equal(t('verifying', 'task_failed'), 'failed');
  assert.equal(t('repairing', 'task_failed'), 'failed');
  assert.equal(t('blocked', 'task_failed'), 'failed');
  assert.equal(t('executing', 'task_abandoned'), 'abandoned');
  assert.equal(t('failed', 'task_resumed'), 'executing');
  assert.equal(t('abandoned', 'task_resumed'), 'executing');
});

test('status view and outcome mapping cover every phase', () => {
  const views = new Map();
  for (const phase of TASK_PHASES) {
    const view = taskStatusView(phase);
    assert.ok(['idle', 'planning', 'executing', 'blocked', 'completed'].includes(view));
    views.set(view, (views.get(view) ?? 0) + 1);
  }
  assert.equal(views.get('idle'), 1);
  assert.equal(views.get('planning'), 3);
  assert.equal(views.get('executing'), 5);
  assert.equal(views.get('blocked'), 1);
  assert.equal(views.get('completed'), 3);

  assert.equal(deriveTaskOutcome('accepted'), 'pass');
  assert.equal(deriveTaskOutcome('failed'), 'fail');
  assert.equal(deriveTaskOutcome('abandoned'), 'fail');
  assert.equal(deriveTaskOutcome('blocked'), 'needs-user');
  assert.equal(deriveTaskOutcome('executing'), undefined);
  assert.equal(formatTaskPhase('reverifying'), 'Reverifying');
});

test('formatFailureRecord renders symptom, diagnosis, repair and resolution', () => {
  const failure = {
    failureId: 'f1',
    taskId: 'task_x',
    stage: 'verifying',
    symptom: 'camera_fps expected >=30, observed 17.2',
    diagnosis: 'pipeline drops frames under load',
    rootCause: 'buffer count too low',
    attempt: 1,
    resolved: true,
    timestamp: 1,
  };
  const repairs = [
    {
      repairId: 'r1',
      taskId: 'task_x',
      failureId: 'f1',
      action: 'buffer 3 -> 6',
      changedFiles: ['config.yaml'],
      timestamp: 2,
    },
    { repairId: 'r2', taskId: 'task_x', failureId: 'other', action: 'unrelated', timestamp: 3 },
  ];
  const text = formatFailureRecord(failure, repairs);
  assert.match(text, /FAIL #1 \[verifying\] camera_fps expected >=30, observed 17\.2/);
  assert.match(text, /Diagnosis: pipeline drops frames under load/);
  assert.match(text, /Root cause: buffer count too low/);
  assert.match(text, /Repair: buffer 3 -> 6/);
  assert.match(text, /Changed: config\.yaml/);
  assert.doesNotMatch(text, /unrelated/);
  assert.match(text, /Status: resolved/);
});
