#!/usr/bin/env node
/**
 * Task engine (Task OS M3): goal → plan → execute → verify → (fail → repair
 * → reverify) → acceptance, with a mock agent whose only powers are the
 * store/artifact writes a real agent would do through tools. PASS can only
 * come from the verdict provider — asserted end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossError } from '../dist/errors.js';

import {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_MAX_TURNS,
  runTask,
  resumeTask,
  summarizeTaskRun,
} from '../dist/core/task/task-engine.js';
import { createAgentTurnRunner } from '../dist/core/task/agent-turn.js';
import {
  appendTaskEvent,
  createDraftTask,
  listTaskEvents,
  recordFailure,
  recordRepair,
} from '../dist/core/task/task-store.js';
import { setRootLogSink } from '../dist/logger.js';
import { appendTaskRecord, appendEvidenceRecord } from '../dist/core/task-runtime/artifacts.js';
import { createCommandVerdictProvider } from '../dist/core/task/verdict.js';

test('planning prompt completes the goal: plan, then implement, then verify', async () => {
  const ws = await tmpWorkspace();
  const { runTurn, calls } = mockAgent(ws, []);
  await runTask({ workspaceDir: ws, runTurn, maxTurns: 1 }, 'add a twenty-line helper');
  const prompt = calls[0]?.prompt ?? '';
  assert.match(prompt, /\[task-phase:planning\]/);
  assert.match(prompt, /plan, then implement, then verify/);
  assert.match(prompt, /Goal: add a twenty-line helper/);
  assert.match(prompt, /Implement the plan now/);
  assert.match(prompt, /task_acceptance/);
  assert.match(prompt, /do not call ask_user_question/i);
  assert.doesNotMatch(prompt, /do not implement|don't implement|no implementation|then stop\./i);
});

test('planning turn that already satisfies acceptance is the only model turn', async () => {
  const ws = await tmpWorkspace();
  const { runTurn, calls } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'camera FPS >=30',
        acceptanceCriteria: [{ metric: 'camera_fps', expected: '>=30' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'device_exec',
        metric: 'camera_fps',
        expected: '>=30',
        observed: 31,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const result = await runTask({ workspaceDir: ws, runTurn }, 'camera FPS >=30');
  assert.equal(calls.length, 1, 'a passing planning turn must not start an execution round');
  assert.equal(calls[0].phase, 'planning');
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
});

test('a command acceptance waits for the execution turn when planning has not passed', async () => {
  const ws = await tmpWorkspace();
  let runs = 0;
  const { runTurn, calls } = mockAgent(ws, [async () => {}, async () => {}]);
  const inner = createCommandVerdictProvider('false');
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn,
      maxRepairAttempts: 0,
      verdictProvider: {
        source: 'command',
        async evaluate(taskId, signal) {
          runs += 1;
          assert.deepEqual(
            calls.map((call) => call.phase),
            ['planning', 'executing'],
            'the command must not run before the execution turn'
          );
          return inner.evaluate(taskId, signal);
        },
      },
    },
    'command must pass'
  );
  assert.equal(runs, 1, 'a red command is not spawned again before repair');
  assert.equal(result.outcome, 'fail');
  const types = (await listTaskEvents(ws, result.snapshot.taskId)).map((event) => event.type);
  assert.ok(types.includes('verification_started'));
  assert.ok(types.includes('acceptance_fail'));
  assert.equal(types.at(-1), 'task_failed');
});

test('a satisfied planning contract runs the command once and skips the execution turn', async () => {
  const ws = await tmpWorkspace();
  let runs = 0;
  const { runTurn, calls } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      const taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'command gate',
        acceptanceCriteria: [{ metric: 'camera_fps', expected: '>=30' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'test',
        metric: 'camera_fps',
        expected: '>=30',
        observed: 31,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const inner = createCommandVerdictProvider('true');
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn,
      verdictProvider: {
        source: 'command',
        async evaluate(taskId, signal) {
          runs += 1;
          return inner.evaluate(taskId, signal);
        },
      },
    },
    'command gate'
  );
  assert.equal(runs, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'planning');
  assert.equal(result.outcome, 'pass');
});

test('a repair turn that already accepted does not crash on repair_applied', async () => {
  const ws = await tmpWorkspace();
  let taskId;
  const { runTurn, calls } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'repair then accept',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    async () => {},
    async (dir) => {
      await appendTaskEvent(dir, taskId, 'verification_started');
      await appendTaskEvent(dir, taskId, 'acceptance_pass', { detail: 'repaired in the turn' });
    },
  ]);
  const result = await runTask({ workspaceDir: ws, runTurn }, 'repair then accept');
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  assert.equal(calls.at(-1).phase, 'repairing');
  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.equal(types.filter((type) => type === 'repair_applied').length, 0);
  assert.equal(types.at(-1), 'acceptance_pass');
});

test('accepted in a turn plus abort returns pass without throwing', async () => {
  const ws = await tmpWorkspace();
  const controller = new AbortController();
  let taskId;
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'accept then abort',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    async () => {
      await appendTaskEvent(ws, taskId, 'verification_started');
      await appendTaskEvent(ws, taskId, 'acceptance_pass', { detail: 'accepted before esc' });
      controller.abort();
    },
  ]);
  const result = await runTask(
    { workspaceDir: ws, runTurn, signal: controller.signal },
    'accept then abort'
  );
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.equal(types.includes('task_failed'), false);
  assert.equal(types.at(-1), 'acceptance_pass');
});

test('an execution turn that already accepted is not reopened by a failing command', async () => {
  const ws = await tmpWorkspace();
  let taskId;
  let runs = 0;
  const { runTurn, calls } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'already accepted',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    async (dir) => {
      await appendTaskEvent(dir, taskId, 'verification_started');
      await appendTaskEvent(dir, taskId, 'acceptance_pass', { detail: 'agent accepted' });
    },
  ]);
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn,
      verdictProvider: {
        source: 'command',
        async evaluate(id) {
          runs += 1;
          return {
            taskId: id,
            passed: false,
            source: 'command',
            detail: 'acceptance command failed (exit 1)',
          };
        },
      },
    },
    'already accepted'
  );
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  assert.equal(runs, 0);
  assert.deepEqual(
    calls.map((call) => call.phase),
    ['planning', 'executing']
  );
  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.equal(types.filter((type) => type === 'verification_started').length, 1);
});

test('task_abandoned during planning ends as fail without throwing', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      await appendTaskEvent(dir, events[0].taskId, 'task_abandoned', { reason: '/goal clear' });
    },
  ]);
  const result = await runTask({ workspaceDir: ws, runTurn }, 'cleared mid plan');
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'abandoned');
});

test('planning handoff skips events only when the turn already accepted', async () => {
  const ws = await tmpWorkspace();
  const { runTurn, calls } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      const taskId = events[0].taskId;
      await appendTaskEvent(dir, taskId, 'plan_ready');
      await appendTaskEvent(dir, taskId, 'execution_started');
      await appendTaskEvent(dir, taskId, 'verification_started');
      await appendTaskEvent(dir, taskId, 'acceptance_pass', { detail: 'planning already passed' });
    },
  ]);
  const result = await runTask({ workspaceDir: ws, runTurn }, 'already accepted in planning');
  assert.equal(result.outcome, 'pass');
  assert.equal(calls.length, 1);
  const types = (await listTaskEvents(ws, result.snapshot.taskId)).map((event) => event.type);
  assert.equal(types.filter((type) => type === 'plan_ready').length, 1);
  assert.equal(types.filter((type) => type === 'execution_started').length, 1);
  assert.equal(types.at(-1), 'acceptance_pass');
});

test('planning handoff logs and throws an illegal transition other than already-accepted', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await listTaskEvents(dir);
      const taskId = events[0].taskId;
      await appendTaskEvent(dir, taskId, 'plan_ready');
      await appendTaskEvent(dir, taskId, 'execution_started');
      await appendTaskEvent(dir, taskId, 'verification_started');
    },
  ]);
  const warnings = [];
  setRootLogSink((entry) => {
    if (entry.level === 'warn') warnings.push(entry);
  });
  try {
    await assert.rejects(
      () => runTask({ workspaceDir: ws, runTurn }, 'stuck in verifying'),
      /not valid from phase verifying/
    );
  } finally {
    setRootLogSink(null);
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, 'refusing illegal task phase transition');
  assert.equal(warnings[0].data.type, 'plan_ready');
  assert.equal(warnings[0].data.phase, 'verifying');
});

test('a held task event lock surfaces as a lock timeout, not a crashed run', async () => {
  const ws = await tmpWorkspace();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const { runTurn } = mockAgent(ws, [
      async (dir) => {
        await fs.writeFile(
          path.join(dir, '.moss', 'task-events.jsonl.lock'),
          String(child.pid),
          'utf8'
        );
      },
    ]);
    const started = Date.now();
    await assert.rejects(
      () => runTask({ workspaceDir: ws, runTurn }, 'lock timeout'),
      (err) => {
        assert.ok(err instanceof MossError);
        assert.equal(err.code, 'EXECUTION_LEASE_HELD');
        assert.match(err.message, /task event lock/);
        assert.doesNotMatch(err.message, /run crashed/);
        return true;
      }
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, `lock timeout took ${elapsed}ms (a second wait would be ~10s)`);
    const raw = await fs.readFile(path.join(ws, '.moss', 'task-events.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /run crashed/);
  } finally {
    child.kill();
  }
});

test('long-horizon defaults outlast a short demo loop', () => {
  assert.ok(DEFAULT_MAX_TURNS >= 24, `turn budget is ${DEFAULT_MAX_TURNS}`);
  assert.ok(DEFAULT_MAX_REPAIR_ATTEMPTS >= 5, `repair budget is ${DEFAULT_MAX_REPAIR_ATTEMPTS}`);
});

async function tmpWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-engine-'));
}

function mockAgent(workspaceDir, script) {
  const calls = [];
  const runTurn = async (prompt, phase) => {
    calls.push({ prompt, phase });
    const action = script[calls.length - 1] ?? (() => {});
    await action(workspaceDir, calls.length - 1);
    return `turn ${calls.length} (${phase}) done`;
  };
  return { runTurn, calls };
}

test('full chain: fail → repair → reverify → accepted, driven only by evidence', async () => {
  const ws = await tmpWorkspace();
  let taskId;
  const { runTurn } = mockAgent(ws, [
    // planning turn: define the contract
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'camera FPS >=30 on device',
        acceptanceCriteria: [{ metric: 'camera_fps', expected: '>=30' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    // first execution turn: no evidence recorded yet → verdict must fail
    () => {},
    // repair turn: record failure, repair, and passing evidence
    async (dir) => {
      await recordFailure(dir, {
        taskId,
        stage: 'verifying',
        symptom: 'camera_fps: no evidence',
        diagnosis: 'pipeline never measured',
        attempt: 1,
        resolved: true,
      });
      await recordRepair(dir, { taskId, action: 'measure pipeline fps', changedFiles: [] });
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'device_exec',
        metric: 'camera_fps',
        expected: '>=30',
        observed: 31.4,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
    // second execution turn: evidence already passing; acceptance confirms
    () => {},
  ]);

  const result = await runTask({ workspaceDir: ws, runTurn }, 'camera FPS >=30 on device');
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  assert.equal(result.snapshot.attempt, 2);
  assert.equal(result.snapshot.statusView, 'completed');
  assert.equal(result.snapshot.failures.length, 1);
  assert.equal(result.snapshot.repairs.length, 1);
  assert.equal(result.snapshot.evidenceCount, 1);
  assert.equal(result.snapshot.lastVerdict.verdict, 'pass');

  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.deepEqual(types, [
    'task_created',
    'task_understood',
    'planning_started',
    'plan_ready',
    'execution_started',
    'verification_started',
    'acceptance_fail',
    'repair_applied',
    'verification_started',
    'acceptance_pass',
  ]);

  const summary = summarizeTaskRun(result);
  assert.match(summary, /Task task_\S+ — PASS/);
  assert.match(summary, /attempts: 2 · repairs: 1 · failures: 1/);
  assert.match(summary, /Acceptance passed/);

  // v0.25: locale-aware summary. Labels follow the caller's locale and match
  // formatTaskStatus's wording; the outcome token, task id and verdict body
  // stay verbatim. Default (no locale) stays English for SDK callers.
  const zhSummary = summarizeTaskRun(result, 'zh_CN.UTF-8');
  assert.match(zhSummary, /任务 task_\S+ — PASS/);
  assert.match(zhSummary, /目标: camera FPS >=30 on device/);
  assert.match(zhSummary, /尝试: 2 · 修复: 1 · 失败: 1/);
  assert.match(zhSummary, /最终裁决:/);
  assert.match(zhSummary, /Acceptance passed/, 'verdict body stays verbatim under zh');
  assert.doesNotMatch(summarizeTaskRun(result), /任务/, 'no locale → English default');
  assert.match(summarizeTaskRun(result, 'en_US.UTF-8'), /^Task task_/, 'explicit en stays English');
  // phases recorded on events never regress
  const phases = (await listTaskEvents(ws, taskId)).map((event) => event.phase);
  assert.equal(phases[phases.length - 1], 'accepted');
});

test('repair budget exhausted ends as failed — no prose can flip it', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'never satisfiable',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
    () => {},
  ]);
  const result = await runTask(
    { workspaceDir: ws, runTurn, maxRepairAttempts: 0 },
    'never satisfiable'
  );
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'failed');
  assert.equal(result.snapshot.attempt, 1);
  const types = (await listTaskEvents(ws, result.snapshot.taskId)).map((e) => e.type);
  assert.ok(types.includes('task_failed'));
});

test('command verdict provider: exit-code acceptance without criteria (goal-loop unification)', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'make `npm test` pass',
        acceptanceCriteria: [{ metric: 'command', expected: 'exists' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
  ]);
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn,
      verdictProvider: createCommandVerdictProvider('true'),
    },
    'make `npm test` pass'
  );
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  assert.equal(result.snapshot.attempt, 1);
  assert.match(result.verdictDetail, /exited 0/);
});

test('turn budget exhausted fails the task instead of looping forever', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'stuck task',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
  ]);
  const result = await runTask({ workspaceDir: ws, runTurn, maxTurns: 1 }, 'stuck task');
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'failed');
  const events = await listTaskEvents(ws, result.snapshot.taskId);
  assert.match(events.find((e) => e.type === 'task_failed').data.detail, /turn budget exhausted/);
});

test('resumeTask re-enters execution and can finish a failed task', async () => {
  const ws = await tmpWorkspace();
  let taskId;
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'resume me',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
    () => {},
  ]);
  const first = await runTask({ workspaceDir: ws, runTurn, maxRepairAttempts: 0 }, 'resume me');
  assert.equal(first.outcome, 'fail');

  const repairAgent = mockAgent(ws, [
    async (dir) => {
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'device_exec',
        metric: 'x',
        expected: '>=1',
        observed: 2,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const second = await resumeTask({ workspaceDir: ws, runTurn: repairAgent.runTurn }, taskId);
  assert.equal(second.outcome, 'pass');
  assert.equal(second.snapshot.phase, 'accepted');
  const types = (await listTaskEvents(ws, taskId)).map((e) => e.type);
  assert.ok(types.includes('task_resumed'));
  assert.equal(types[types.length - 1], 'acceptance_pass');
});

test('resumeTask re-enters a task left executing', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'left executing');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskRecord(ws, {
    taskId,
    goal: 'left executing',
    acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await appendEvidenceRecord(ws, {
    evidenceId: 'ev_left_executing',
    taskId,
    source: 'test',
    metric: 'x',
    expected: '>=1',
    observed: 2,
    result: 'pass',
    timestamp: Date.now(),
  });
  const { runTurn } = mockAgent(ws, [async () => {}]);
  const result = await resumeTask({ workspaceDir: ws, runTurn }, taskId);
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.equal(types.includes('task_resumed'), false);
  assert.equal(types.at(-1), 'acceptance_pass');
});

test('resumeTask refuses an accepted task and a missing task', async () => {
  const ws = await tmpWorkspace();
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(dir)
      );
      const tid = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId: tid,
        goal: 'done task',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId: tid,
        source: 'test',
        metric: 'x',
        expected: '>=1',
        observed: 5,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
    () => {},
  ]);
  const done = await runTask({ workspaceDir: ws, runTurn }, 'done task');
  await assert.rejects(
    () => resumeTask({ workspaceDir: ws, runTurn }, done.snapshot.taskId),
    /already accepted/
  );
  await assert.rejects(
    () => resumeTask({ workspaceDir: ws, runTurn }, 'task_missing'),
    /not found/
  );
});

async function executingTask(ws) {
  const { taskId } = await createDraftTask(ws, 'resume then esc');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskRecord(ws, {
    taskId,
    goal: 'resume then esc',
    acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return taskId;
}

function assertAborted(result, events) {
  assert.equal(result.outcome, 'aborted');
  assert.equal(result.snapshot.phase, 'failed');
  const failed = [...events].reverse().find((event) => event.type === 'task_failed');
  assert.equal(failed?.data?.detail, 'aborted');
  assert.equal(
    events.some((event) => /run crashed/.test(String(event.data?.detail ?? ''))),
    false
  );
}

async function finishAfterAbort(ws, taskId) {
  const { runTurn } = mockAgent(ws, [
    async (dir) => {
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'test',
        metric: 'x',
        expected: '>=1',
        observed: 2,
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const again = await resumeTask({ workspaceDir: ws, runTurn }, taskId);
  assert.equal(again.outcome, 'pass');
  assert.equal(again.snapshot.phase, 'accepted');
}

const failingVerdict = {
  source: 'contract',
  async evaluate() {
    return { passed: false, detail: 'not yet', source: 'contract' };
  },
};

test('esc during the resumed execution turn is aborted, not crashed, and resumable', async () => {
  const ws = await tmpWorkspace();
  const taskId = await executingTask(ws);
  const controller = new AbortController();
  let evaluations = 0;
  const { runTurn, calls } = mockAgent(ws, [
    async () => {
      controller.abort();
    },
  ]);
  const result = await resumeTask(
    {
      workspaceDir: ws,
      runTurn,
      signal: controller.signal,
      verdictProvider: {
        source: 'contract',
        async evaluate() {
          evaluations += 1;
          return { passed: false, detail: 'should not run', source: 'contract' };
        },
      },
    },
    taskId
  );
  assert.equal(evaluations, 0);
  assert.deepEqual(
    calls.map((call) => call.phase),
    ['executing']
  );
  assertAborted(result, await listTaskEvents(ws, taskId));
  await finishAfterAbort(ws, taskId);
});

test('esc during verification aborts before the repair turn', async () => {
  const ws = await tmpWorkspace();
  const taskId = await executingTask(ws);
  const controller = new AbortController();
  const { runTurn, calls } = mockAgent(ws, [async () => {}]);
  const result = await resumeTask(
    {
      workspaceDir: ws,
      runTurn,
      signal: controller.signal,
      verdictProvider: {
        source: 'contract',
        async evaluate() {
          controller.abort();
          return { passed: false, detail: 'not yet', source: 'contract' };
        },
      },
    },
    taskId
  );
  assert.deepEqual(
    calls.map((call) => call.phase),
    ['executing']
  );
  const events = await listTaskEvents(ws, taskId);
  assertAborted(result, events);
  assert.equal(
    events.some((event) => event.type === 'acceptance_fail'),
    false,
    'esc during acceptance does not record a fake acceptance_fail'
  );
  assert.equal(
    events.some((event) => event.type === 'repair_applied'),
    false
  );
  await finishAfterAbort(ws, taskId);
});

test('esc during the repair turn is aborted, not crashed, and resumable', async () => {
  const ws = await tmpWorkspace();
  const taskId = await executingTask(ws);
  const controller = new AbortController();
  const { runTurn, calls } = mockAgent(ws, [
    async () => {},
    async () => {
      controller.abort();
    },
  ]);
  const result = await resumeTask(
    {
      workspaceDir: ws,
      runTurn,
      signal: controller.signal,
      verdictProvider: failingVerdict,
    },
    taskId
  );
  assert.deepEqual(
    calls.map((call) => call.phase),
    ['executing', 'repairing']
  );
  const events = await listTaskEvents(ws, taskId);
  assertAborted(result, events);
  assert.equal(events.filter((event) => event.type === 'repair_applied').length, 0);
  await finishAfterAbort(ws, taskId);
});

test('a repair turn that throws USER_ABORTED is aborted, not crashed', async () => {
  const ws = await tmpWorkspace();
  const taskId = await executingTask(ws);
  const { runTurn } = mockAgent(ws, [
    async () => {},
    async () => {
      throw new MossError({
        code: 'USER_ABORTED',
        message: 'agent run aborted before start: This operation was aborted',
      });
    },
  ]);
  const result = await resumeTask(
    { workspaceDir: ws, runTurn, verdictProvider: failingVerdict },
    taskId
  );
  assertAborted(result, await listTaskEvents(ws, taskId));
  await finishAfterAbort(ws, taskId);
});

test('esc during a budget stop is aborted, not a budget failure', async () => {
  const ws = await tmpWorkspace();
  const taskId = await executingTask(ws);
  const controller = new AbortController();
  const runTurn = async () => {
    controller.abort();
    return { text: 'ceiling', stopReason: 'budget_tokens_reached' };
  };
  const result = await resumeTask(
    {
      workspaceDir: ws,
      runTurn,
      signal: controller.signal,
      verdictProvider: failingVerdict,
    },
    taskId
  );
  const events = await listTaskEvents(ws, taskId);
  assertAborted(result, events);
  assert.equal(
    events.some((event) => /run budget exceeded/.test(String(event.data?.detail ?? ''))),
    false
  );
});

test('esc during acceptance that throws a plain error is aborted, not crashed', async () => {
  const ws = await tmpWorkspace();
  const taskId = await executingTask(ws);
  const controller = new AbortController();
  const { runTurn } = mockAgent(ws, [async () => {}]);
  const result = await resumeTask(
    {
      workspaceDir: ws,
      runTurn,
      signal: controller.signal,
      verdictProvider: {
        source: 'contract',
        async evaluate() {
          controller.abort();
          throw new Error('acceptance probe blew up');
        },
      },
    },
    taskId
  );
  const events = await listTaskEvents(ws, taskId);
  assertAborted(result, events);
  assert.equal(
    events.some((event) => event.type === 'acceptance_fail'),
    false
  );
});

test('esc during planning records aborted and does not start execution', async () => {
  const ws = await tmpWorkspace();
  const controller = new AbortController();
  const { runTurn, calls } = mockAgent(ws, [
    async () => {
      controller.abort();
    },
  ]);
  const result = await runTask(
    { workspaceDir: ws, runTurn, signal: controller.signal },
    'plan then stop'
  );
  assert.deepEqual(
    calls.map((call) => call.phase),
    ['planning']
  );
  const events = await listTaskEvents(ws, result.snapshot.taskId);
  assertAborted(result, events);
  assert.equal(
    events.some((event) => event.type === 'execution_started'),
    false
  );
});

test('a crashed run marks the task failed — never stuck unresumable in a live phase', async () => {
  const ws = await tmpWorkspace();
  const crash = async () => {
    throw new Error('gateway exploded mid-turn');
  };
  await assert.rejects(
    () => runTask({ workspaceDir: ws, runTurn: crash }, 'camera FPS >=30 on device'),
    /gateway exploded/
  );

  // The only task in the workspace is the crashed one; it must be failed, not
  // stuck in planning, so the user can /task resume it.
  const { listTaskStateSnapshots } = await import('../dist/core/task/task-store.js');
  const snapshots = await listTaskStateSnapshots(ws);
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.phase, 'failed', 'a crashed run lands in the failed phase');
  const types = (await listTaskEvents(ws, snapshot.taskId)).map((e) => e.type);
  assert.ok(types.includes('task_failed'), 'the crash is recorded as task_failed');

  // resumeTask re-enters the cycle instead of refusing with "nothing to resume".
  await assert.rejects(
    () => resumeTask({ workspaceDir: ws, runTurn: crash }, snapshot.taskId),
    (err) => !/nothing to resume/.test(err.message),
    'a failed-by-crash task is resumable'
  );
});

test('run budget stop ends the task without another turn', async () => {
  const ws = await tmpWorkspace();
  const calls = [];
  const runTurn = async (_prompt, phase) => {
    calls.push(phase);
    if (phase === 'planning') {
      const events = await import('../dist/core/task/task-store.js').then((m) =>
        m.listTaskEvents(ws)
      );
      const taskId = events[0].taskId;
      await appendTaskRecord(ws, {
        taskId,
        goal: 'stay under the run budget',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return 'plan only';
    }
    // A non-budget stop still continues into repair. The repair turn is the
    // one that hits the ceiling and must not be followed by another execution.
    if (phase === 'executing') return { text: 'not done yet', stopReason: 'end_turn' };
    return { text: 'tool-call ceiling', stopReason: 'budget_tool_calls_reached' };
  };
  const result = await runTask(
    { workspaceDir: ws, runTurn, maxTurns: 8, maxRepairAttempts: 5 },
    'stay under the run budget'
  );
  assert.deepEqual(calls, ['planning', 'executing', 'repairing']);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'failed');
  const failed = (await listTaskEvents(ws, result.snapshot.taskId)).find(
    (event) => event.type === 'task_failed'
  );
  assert.match(failed.data.detail, /run budget exceeded \(budget_tool_calls_reached\)/);

  const planWs = await tmpWorkspace();
  const planCalls = [];
  const planTurn = async (_prompt, phase) => {
    planCalls.push(phase);
    return { text: 'token ceiling during planning', stopReason: 'budget_tokens_reached' };
  };
  const planned = await runTask(
    { workspaceDir: planWs, runTurn: planTurn, maxTurns: 8 },
    'plan until the token budget'
  );
  assert.deepEqual(planCalls, ['planning']);
  assert.equal(planned.outcome, 'fail');
  assert.equal(planned.snapshot.phase, 'failed');
  const planFailed = (await listTaskEvents(planWs, planned.snapshot.taskId)).find(
    (event) => event.type === 'task_failed'
  );
  assert.match(planFailed.data.detail, /run budget exceeded \(budget_tokens_reached\)/);
});

test('accepted turn that also hits the run budget stays pass', async () => {
  const ws = await tmpWorkspace();
  const calls = [];
  let taskId;
  const runTurn = async (_prompt, phase) => {
    calls.push(phase);
    if (phase === 'planning') {
      const events = await listTaskEvents(ws);
      taskId = events[0].taskId;
      await appendTaskRecord(ws, {
        taskId,
        goal: 'accept then budget',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return 'plan only';
    }
    await appendTaskEvent(ws, taskId, 'verification_started');
    await appendTaskEvent(ws, taskId, 'acceptance_pass', { detail: 'accepted in the turn' });
    return { text: 'accepted and out of tokens', stopReason: 'budget_tokens_reached' };
  };
  const result = await runTask({ workspaceDir: ws, runTurn, maxTurns: 8 }, 'accept then budget');
  assert.deepEqual(calls, ['planning', 'executing']);
  assert.equal(result.outcome, 'pass');
  assert.equal(result.snapshot.phase, 'accepted');
  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.equal(types.includes('task_failed'), false);
  assert.equal(types.at(-1), 'acceptance_pass');
});

test('blocked turn that also hits the run budget stays blocked', async () => {
  const ws = await tmpWorkspace();
  const calls = [];
  let taskId;
  const runTurn = async (_prompt, phase) => {
    calls.push(phase);
    if (phase === 'planning') {
      const events = await listTaskEvents(ws);
      taskId = events[0].taskId;
      await appendTaskRecord(ws, {
        taskId,
        goal: 'block then budget',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return 'plan only';
    }
    await appendTaskEvent(ws, taskId, 'blocked_on_user', { reason: 'need a credential' });
    return { text: 'waiting on the user', stopReason: 'budget_tool_calls_reached' };
  };
  const result = await runTask({ workspaceDir: ws, runTurn, maxTurns: 8 }, 'block then budget');
  assert.deepEqual(calls, ['planning', 'executing']);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.snapshot.phase, 'blocked');
  const types = (await listTaskEvents(ws, taskId)).map((event) => event.type);
  assert.equal(types.includes('task_failed'), false);
  assert.equal(types.at(-1), 'blocked_on_user');
});

test('createAgentTurnRunner reports stopReason from streamChat and chat', async () => {
  let streamCalls = 0;
  let streamOptions;
  const streamAgent = {
    async *streamChat(_session, _prompt, options) {
      streamOptions = options;
      streamCalls += 1;
      yield { type: 'text_delta', delta: 'partial ' };
      if (streamCalls === 1) {
        yield {
          type: 'done',
          result: {
            response: '  final text  ',
            stopReason: 'budget_tokens_reached',
            toolCalls: [],
            toolResults: [],
          },
        };
        return;
      }
      yield { type: 'done', result: { response: 'continued', toolCalls: [], toolResults: [] } };
    },
  };
  const streamRunner = createAgentTurnRunner(streamAgent, 'session-stream');
  assert.equal(await streamRunner('prompt', 'planning'), 'final text');
  assert.equal(streamRunner.stopReason, 'budget_tokens_reached');
  assert.equal(streamOptions.goalExecWait, true);
  assert.equal(streamOptions.taskFlow, true);
  assert.equal(await streamRunner('again', 'executing'), 'continued');
  assert.equal(streamRunner.stopReason, undefined);

  const chatAgent = {
    async chat() {
      return { response: 'chat text', stopReason: 'budget_tool_calls_reached' };
    },
  };
  const chatRunner = createAgentTurnRunner(chatAgent, 'session-chat');
  assert.equal(await chatRunner('prompt', 'executing'), 'chat text');
  assert.equal(chatRunner.stopReason, 'budget_tool_calls_reached');

  const ws = await tmpWorkspace();
  const engineAgent = {
    async *streamChat() {
      yield {
        type: 'done',
        result: {
          response: 'out of tokens',
          stopReason: 'budget_tokens_reached',
          toolCalls: [],
          toolResults: [],
        },
      };
    },
  };
  const runTurn = createAgentTurnRunner(engineAgent, 'session-engine');
  const result = await runTask({ workspaceDir: ws, runTurn }, 'budget via the string runner');
  assert.equal(typeof runTurn.stopReason, 'string');
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.phase, 'failed');
  const failed = (await listTaskEvents(ws, result.snapshot.taskId)).find(
    (event) => event.type === 'task_failed'
  );
  assert.match(failed.data.detail, /run budget exceeded \(budget_tokens_reached\)/);
});
