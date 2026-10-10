#!/usr/bin/env node
/**
 * Small goals finish from one test run. A large goal still wants evidence
 * per metric. Turn counts are the tool rounds the planning prompt asks for,
 * plus the engine turn count on a stub that follows that prompt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyGoalScale } from '../dist/core/task/goal-scale.js';
import { runTask } from '../dist/core/task/task-engine.js';
import { recordHarnessSuiteEvidence } from '../dist/core/task/suite-evidence.js';
import { evaluateContractAcceptance } from '../dist/core/task/verdict.js';
import { appendTaskEvent, listTaskEvents } from '../dist/core/task/task-store.js';
import { appendTaskRecord, listEvidenceRecords } from '../dist/core/task-runtime/artifacts.js';

const SMALL = 'fix the twenty-line helper and its tests';
const LARGE =
  'refactor the camera firmware deploy and migrate the architecture across utils.js app.js driver.js and net.js';
const CRITERIA = 8;

function protocolTurns(prompt, criteriaCount) {
  const perItem = prompt.includes('Record evidence for each acceptance metric');
  // One model response each: define, plan, read, edit, then either one test
  // run or one evidence record per criterion, then task_acceptance.
  return 4 + (perItem ? criteriaCount : 1) + 1;
}

function criteria(prefix, expected) {
  return Array.from({ length: CRITERIA }, (_, index) => ({
    metric: `${prefix}_${index}`,
    expected,
    required: true,
  }));
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-light-'));
}

async function define(dir, taskId, goal, acceptanceCriteria, steps) {
  const now = Date.now();
  await appendTaskRecord(dir, {
    taskId,
    goal,
    acceptanceCriteria,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  if (steps) {
    await appendTaskEvent(dir, taskId, 'plan_step_updated', { steps });
  }
}

test('scale: short text and a 3-step plan are light; a device refactor is full', () => {
  assert.equal(classifyGoalScale({ goal: SMALL, repoFileCount: 12 }), 'light');
  assert.equal(classifyGoalScale({ goal: LARGE, repoFileCount: 12 }), 'full');
  const medium = 'ship the feature. '.repeat(20);
  assert.equal(classifyGoalScale({ goal: medium, repoFileCount: 400 }), 'full');
  assert.equal(classifyGoalScale({ goal: medium, repoFileCount: 12 }), 'light');
  assert.equal(
    classifyGoalScale({ goal: LARGE, repoFileCount: 400, planSteps: 3 }),
    'light',
    'a plan of at most 3 steps uses the light path'
  );
  assert.equal(classifyGoalScale({ goal: SMALL, repoFileCount: 12, planSteps: 8 }), 'light');
});

test('one passing test covers a small goal and does not cover a device metric', async () => {
  const dir = await workspace();
  const { createDraftTask } = await import('../dist/core/task/task-store.js');
  const draft = await createDraftTask(dir, SMALL);
  await define(dir, draft.taskId, SMALL, criteria('item', 'exists'));
  const wrote = await recordHarnessSuiteEvidence({
    workspaceDir: dir,
    taskId: draft.taskId,
    source: 'run_tests',
    testsPassed: true,
    output: 'tests_pass=true\nOK',
  });
  assert.ok(wrote >= CRITERIA, `suite wrote a row per item (${wrote})`);
  const judged = await evaluateContractAcceptance(dir, draft.taskId);
  assert.equal(judged.verdict.verdict, 'pass');
  const evidence = await listEvidenceRecords(dir, 100);
  assert.equal(
    evidence.filter((row) => row.source === 'record_evidence').length,
    0,
    'acceptance did not need a model record_evidence call'
  );

  const device = await createDraftTask(dir, 'camera stays at 30 fps');
  await define(dir, device.taskId, 'camera stays at 30 fps', [
    { metric: 'camera_fps', expected: '>=30', required: true },
  ]);
  await recordHarnessSuiteEvidence({
    workspaceDir: dir,
    taskId: device.taskId,
    source: 'run_tests',
    testsPassed: true,
    output: 'tests_pass=true',
  });
  const deviceJudged = await evaluateContractAcceptance(dir, device.taskId);
  assert.notEqual(deviceJudged.verdict.verdict, 'pass');
});

test('small fixture: light prompt, one engine turn; full prompt still bills per item', async () => {
  const smallDir = await workspace();
  let lightPrompt = '';
  const small = await runTask(
    {
      workspaceDir: smallDir,
      maxTurns: 8,
      runTurn: async (prompt) => {
        lightPrompt = prompt;
        const taskId = (await listTaskEvents(smallDir))[0].taskId;
        await define(smallDir, taskId, SMALL, criteria('item', 'exists'), [
          { stepId: '1', title: 'edit the helper', status: 'done' },
          { stepId: '2', title: 'run tests', status: 'done' },
          { stepId: '3', title: 'accept', status: 'pending' },
        ]);
        await recordHarnessSuiteEvidence({
          workspaceDir: smallDir,
          taskId,
          source: 'run_tests',
          testsPassed: true,
          output: 'tests_pass=true',
        });
        return 'implemented and tested';
      },
    },
    SMALL
  );
  assert.match(lightPrompt, /at most 3 steps/);
  assert.match(lightPrompt, /minimal and scoped/);
  assert.doesNotMatch(lightPrompt, /Record evidence for each acceptance metric/);
  assert.equal(small.outcome, 'pass');
  assert.equal(small.turns, 1, 'the planning turn is enough once the suite covers the items');

  const largeDir = await workspace();
  let fullPrompt = '';
  const large = await runTask(
    {
      workspaceDir: largeDir,
      maxTurns: 1,
      maxRepairAttempts: 0,
      runTurn: async (prompt) => {
        fullPrompt = prompt;
        const taskId = (await listTaskEvents(largeDir))[0].taskId;
        await define(largeDir, taskId, LARGE, criteria('item', 'exists'));
        await recordHarnessSuiteEvidence({
          workspaceDir: largeDir,
          taskId,
          source: 'run_tests',
          testsPassed: true,
          output: 'tests_pass=true',
        });
        return 'tests passed, evidence still per metric';
      },
    },
    LARGE
  );
  assert.match(fullPrompt, /Record evidence for each acceptance metric/);
  assert.match(fullPrompt, /3-8 concrete steps/);
  assert.notEqual(large.outcome, 'pass', 'a large goal does not accept from the suite alone');

  const beforeTurns = protocolTurns(fullPrompt, CRITERIA);
  const afterTurns = protocolTurns(lightPrompt, CRITERIA);
  assert.ok(afterTurns <= 8, `small fixture tool rounds ${afterTurns}`);
  assert.ok(beforeTurns > afterTurns);
  const report = {
    criteria: CRITERIA,
    beforeTurns,
    afterTurns,
    beforeEngineTurns: large.turns,
    afterEngineTurns: small.turns,
    beforePromptChars: fullPrompt.length,
    afterPromptChars: lightPrompt.length,
    beforePromptTokens: Math.ceil(fullPrompt.length / 4),
    afterPromptTokens: Math.ceil(lightPrompt.length / 4),
  };
  console.log(`[goal-light] ${JSON.stringify(report)}`);
  await fs.mkdir('/opt/cursor/artifacts', { recursive: true });
  await fs.writeFile(
    '/opt/cursor/artifacts/goal-light-turns.json',
    `${JSON.stringify(report, null, 2)}\n`
  );
});
