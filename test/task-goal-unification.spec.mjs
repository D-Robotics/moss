#!/usr/bin/env node
/**
 * Task OS M6 — goal loop unification: LoopScheduler acceptance verdicts
 * mirror into the unified task runtime via onAcceptanceVerdict + the shared
 * emitAcceptanceLifecycle, so /goal and MOSS_GOAL_VERIFY_LOOP runs appear in
 * task history with real verdicts. PASS still only comes from the command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LoopScheduler } from '../dist/core/loop/loop-scheduler.js';
import {
  createDraftTask,
  appendTaskEvent,
  emitAcceptanceLifecycle,
  getTaskStateSnapshot,
} from '../dist/core/task/task-store.js';

function createGoalAgent({ responses = ['working on it'], workspaceDir }) {
  return {
    config: {
      workspaceDir,
      model: 'mock',
      llmProvider: {
        async complete() {
          return { content: [{ type: 'text', text: 'DONE' }] };
        },
      },
    },
    async chat(_sessionKey, _prompt) {
      return { response: responses[0], stopReason: 'end_turn' };
    },
  };
}

async function tempWs() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-unify-'));
}

test('acceptance pass mirrors acceptance_pass onto the bound task', async () => {
  const ws = await tempWs();
  const agent = createGoalAgent({ workspaceDir: ws });
  const contract = await createDraftTask(ws, 'goal with command authority');
  await appendTaskEvent(ws, contract.taskId, 'execution_started');

  const sched = new LoopScheduler(agent, {
    prompt: 'make the check pass',
    intervalMs: 0,
    journal: false,
    autonomous: true,
    acceptance: { command: 'exit 0' },
    sessionKey: 'task-goal-unify-pass',
    onAcceptanceVerdict: async (result) => {
      await emitAcceptanceLifecycle(
        ws,
        contract.taskId,
        result.passed,
        result.passed ? 'goal acceptance command exited 0' : `exit ${result.exitCode}`
      );
    },
  });
  await sched.start();
  assert.equal(sched.getState().status, 'completed');

  const snapshot = await getTaskStateSnapshot(ws, contract.taskId);
  assert.equal(snapshot.phase, 'accepted');
  assert.equal(snapshot.attempt, 1);
  assert.equal(snapshot.outcome, 'pass');
});

test('acceptance fail mirrors acceptance_fail → diagnosing; later pass → accepted', async () => {
  const ws = await tempWs();
  const agent = createGoalAgent({ workspaceDir: ws, responses: ['fixing it'] });
  const contract = await createDraftTask(ws, 'flaky goal');
  await appendTaskEvent(ws, contract.taskId, 'execution_started');

  // Deterministic flip: first run fails (creates the marker), second passes.
  // The gate is a node script ON DISK invoked bare (`node <abs> <marker>`) —
  // the old `sh -c "if [ -f … ]"` acceptance command was at the mercy of
  // whatever `sh` a runner image ships (GitHub's windows-latest image churn
  // flipped it red), per the scripts-on-disk Windows-CI rule.
  const marker = path.join(os.tmpdir(), `moss-goal-unify-${Date.now()}.marker`);
  const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-gate-'));
  const gate = path.join(gateDir, 'accept-once.mjs');
  await fs.writeFile(
    gate,
    [
      "import fs from 'node:fs';",
      'const marker = process.argv[2];',
      'if (fs.existsSync(marker)) process.exit(0);',
      "fs.writeFileSync(marker, 'x');",
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8'
  );
  const sched = new LoopScheduler(agent, {
    prompt: 'make the check pass',
    intervalMs: 0,
    journal: false,
    autonomous: true,
    maxIterations: 3,
    acceptance: { command: `node ${gate} ${marker}` },
    onAcceptanceVerdict: async (result) => {
      await emitAcceptanceLifecycle(ws, contract.taskId, result.passed, `exit ${result.exitCode}`);
    },
  });
  await sched.start();
  await fs.rm(marker, { force: true }).catch(() => undefined);
  assert.equal(sched.getState().status, 'completed');

  const snapshot = await getTaskStateSnapshot(ws, contract.taskId);
  assert.equal(snapshot.phase, 'accepted');
  assert.equal(snapshot.attempt, 2);
});

test('emitAcceptanceLifecycle is a no-op for unknown and settled tasks', async () => {
  const ws = await tempWs();
  await assert.doesNotReject(() => emitAcceptanceLifecycle(ws, 'task_unknown', true, 'x'));
  const settled = await createDraftTask(ws, 'settled');
  const { taskId } = settled;
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_pass');
  await assert.doesNotReject(() => emitAcceptanceLifecycle(ws, taskId, false, 'late fail'));
  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'accepted');
});
