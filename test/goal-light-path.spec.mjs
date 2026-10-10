#!/usr/bin/env node
/**
 * A test run records tests_pass / build_ok / typecheck_ok only, and only on
 * a task turn. It does not accept an unrelated criterion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTask } from '../dist/core/task/task-engine.js';
import { recordHarnessSuiteEvidence } from '../dist/core/task/suite-evidence.js';
import { evaluateContractAcceptance } from '../dist/core/task/verdict.js';
import { listTaskEvents } from '../dist/core/task/task-store.js';
import { appendTaskRecord, listEvidenceRecords } from '../dist/core/task-runtime/artifacts.js';

const SMALL = 'fix the twenty-line helper and its tests';

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-suite-'));
}

async function define(dir, taskId, goal, acceptanceCriteria) {
  const now = Date.now();
  await appendTaskRecord(dir, {
    taskId,
    goal,
    acceptanceCriteria,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

test('a suite run satisfies only tests_pass, build_ok, and typecheck_ok', async () => {
  const dir = await workspace();
  const { createDraftTask } = await import('../dist/core/task/task-store.js');
  const draft = await createDraftTask(dir, SMALL);
  await define(dir, draft.taskId, SMALL, [
    { metric: 'tests_pass', expected: '==true', required: true },
    { metric: 'readme_documents_verbose', expected: 'exists', required: true },
    { metric: 'verbose_flag_prints_debug', expected: '==true', required: true },
    { metric: 'motor_spins', expected: '==true', required: true },
    { metric: 'lidar_scan_published', expected: '==true', required: true },
    { metric: 'servo_angle_ok', expected: '==pass', required: true },
    { metric: '电机转速正常', expected: '==true', required: true },
    { metric: '相机画面', expected: 'exists', required: true },
    { metric: 'unknown_route_returns_404', expected: '==true', required: true },
    { metric: 'build_ok', expected: '==true', required: true },
    { metric: 'typecheck_ok', expected: '==true', required: true },
  ]);
  const wrote = await recordHarnessSuiteEvidence({
    workspaceDir: dir,
    taskId: draft.taskId,
    source: 'run_tests',
    testsPassed: true,
    buildPassed: true,
    typecheckPassed: false,
    output: 'tests_pass=true',
  });
  assert.equal(wrote, 3);
  const judged = await evaluateContractAcceptance(dir, draft.taskId);
  assert.equal(judged.verdict.verdict, 'fail');
  const byMetric = Object.fromEntries(
    judged.verdict.criteriaResults.map((row) => [row.metric, row.result])
  );
  assert.equal(byMetric.tests_pass, 'pass');
  assert.equal(byMetric.build_ok, 'pass');
  assert.equal(byMetric.typecheck_ok, 'fail');
  for (const metric of [
    'readme_documents_verbose',
    'verbose_flag_prints_debug',
    'motor_spins',
    'lidar_scan_published',
    'servo_angle_ok',
    '电机转速正常',
    '相机画面',
    'unknown_route_returns_404',
  ]) {
    assert.equal(byMetric[metric], 'no-evidence', metric);
  }
});

test('ordinary chat does not attach a test run to a live goal', async () => {
  const dir = await workspace();
  const { createDraftTask } = await import('../dist/core/task/task-store.js');
  const draft = await createDraftTask(dir, SMALL);
  await define(dir, draft.taskId, SMALL, [
    { metric: 'tests_pass', expected: '==true', required: true },
  ]);
  const wrote = await recordHarnessSuiteEvidence({
    workspaceDir: dir,
    source: 'run_tests',
    testsPassed: true,
    output: 'tests_pass=true',
  });
  assert.equal(wrote, 0);
  assert.equal((await listEvidenceRecords(dir, 20)).length, 0);
  const judged = await evaluateContractAcceptance(dir, draft.taskId);
  assert.equal(judged.verdict.verdict, 'fail');
  assert.equal(judged.verdict.criteriaResults[0].result, 'no-evidence');

  const onTurn = await recordHarnessSuiteEvidence({
    workspaceDir: dir,
    taskTurn: true,
    source: 'run_tests',
    testsPassed: true,
    output: 'tests_pass=true',
  });
  assert.equal(onTurn, 1);
  const passed = await evaluateContractAcceptance(dir, draft.taskId);
  assert.equal(passed.verdict.verdict, 'pass');
});

test('one planning prompt stays lean, and only an exact suite metric accepts early', async () => {
  const prompts = [];
  const exactDir = await workspace();
  const exact = await runTask(
    {
      workspaceDir: exactDir,
      maxTurns: 4,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        const taskId = (await listTaskEvents(exactDir))[0].taskId;
        await define(exactDir, taskId, SMALL, [
          { metric: 'tests_pass', expected: '==true', required: true },
        ]);
        await recordHarnessSuiteEvidence({
          workspaceDir: exactDir,
          taskId,
          source: 'run_tests',
          testsPassed: true,
          output: 'tests_pass=true',
        });
        return 'tested';
      },
    },
    SMALL
  );
  assert.equal(exact.outcome, 'pass');
  assert.equal(exact.turns, 1);
  assert.match(prompts[0], /small code changes: 1–3 steps/);
  assert.match(prompts[0], /at most 8 steps/);
  assert.match(prompts[0], /target_device if a device is involved/);
  assert.match(prompts[0], /tests_pass == true \(not ==pass\)/);
  assert.match(prompts[0], /minimal and scoped/);
  assert.match(prompts[0], /Implement only that change now/);
  assert.doesNotMatch(prompts[0], /Record evidence for each acceptance metric/);
  assert.doesNotMatch(prompts[0], /at most 3 steps/);

  const openDir = await workspace();
  const open = await runTask(
    {
      workspaceDir: openDir,
      maxTurns: 2,
      maxRepairAttempts: 0,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        const taskId = (await listTaskEvents(openDir))[0].taskId;
        await define(openDir, taskId, 'deploy the motor controller', [
          { metric: 'motor_spins', expected: '==true', required: true },
        ]);
        await recordHarnessSuiteEvidence({
          workspaceDir: openDir,
          taskId,
          source: 'run_tests',
          testsPassed: true,
          output: 'assert 1+1==2',
        });
        return 'tests passed';
      },
    },
    'deploy the motor controller'
  );
  assert.notEqual(open.outcome, 'pass');
  assert.match(prompts[1], /minimal and scoped/);
  assert.doesNotMatch(prompts[1], /3-8 concrete steps/);
  assert.equal(prompts.length, 3);
});
