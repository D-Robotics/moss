#!/usr/bin/env node
/**
 * Task contract + acceptance (P0-1/P0-2): criteria evaluation against
 * evidence — latest-wins, no-evidence blocks, optional vs required — plus
 * the task_define / task_acceptance tool lifecycle with persistence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { evaluateAcceptance } from '../dist/contracts/task.js';
import { taskDefineTool, taskAcceptanceTool, listTaskRecords } from '../dist/tools/task-tools.js';
import { listEvidenceRecords, recordEvidenceTool } from '../dist/tools/evidence-tools.js';

function makeCtx(workspaceDir) {
  return { workspaceDir, sessionKey: 'task-contract-test' };
}

function baseTask(overrides = {}) {
  return {
    taskId: 'task_test',
    goal: 'robot stops within 1m of a person',
    acceptanceCriteria: [
      { metric: 'camera_fps', expected: '>=30' },
      { metric: 'stop_distance_m', expected: '<=1' },
      { metric: 'log_noise', expected: 'not-contains CRITICAL', required: false },
    ],
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function ev(metric, observed, result, timestamp, taskId = 'task_test') {
  return {
    evidenceId: `ev_${metric}_${timestamp}`,
    taskId,
    source: 'device_exec',
    metric,
    observed,
    result,
    timestamp,
  };
}

test('evaluateAcceptance: pass / fail / no-evidence / optional semantics', () => {
  const allPass = evaluateAcceptance(baseTask(), [
    ev('camera_fps', 31.2, 'pass', 10),
    ev('stop_distance_m', 0.8, 'pass', 11),
    ev('log_noise', 'all fine', 'pass', 12),
  ]);
  assert.equal(allPass.verdict, 'pass');
  assert.equal(allPass.unmetRequired, 0);

  // Optional criterion unmet → partial, not fail.
  const partial = evaluateAcceptance(baseTask(), [
    ev('camera_fps', 31.2, 'pass', 10),
    ev('stop_distance_m', 0.8, 'pass', 11),
    ev('log_noise', 'CRITICAL overflow', 'fail', 12),
  ]);
  assert.equal(partial.verdict, 'partial');

  // Required criterion failed → fail.
  const failed = evaluateAcceptance(baseTask(), [
    ev('camera_fps', 17.3, 'fail', 10),
    ev('stop_distance_m', 0.8, 'pass', 11),
  ]);
  assert.equal(failed.verdict, 'fail');

  // Missing evidence for a required criterion → no-evidence, acceptance fails.
  const missing = evaluateAcceptance(baseTask(), [ev('camera_fps', 31.2, 'pass', 10)]);
  assert.equal(missing.verdict, 'fail');
  assert.equal(missing.criteriaResults[1].result, 'no-evidence');
  assert.equal(missing.criteriaResults[1].evidenceId, undefined);

  // Evidence from another task is ignored.
  const foreign = evaluateAcceptance(baseTask(), [
    ev('camera_fps', 31.2, 'pass', 10, 'task_other'),
  ]);
  assert.equal(foreign.verdict, 'fail');
  assert.equal(foreign.evidenceConsidered, 0);
});

test('evaluateAcceptance: repaired re-measurement supersedes the earlier failure', () => {
  const twoRequired = baseTask({
    acceptanceCriteria: [
      { metric: 'camera_fps', expected: '>=30' },
      { metric: 'stop_distance_m', expected: '<=1' },
    ],
  });
  const verdict = evaluateAcceptance(twoRequired, [
    ev('camera_fps', 17.3, 'fail', 10),
    ev('camera_fps', 31.2, 'pass', 99),
    ev('stop_distance_m', 0.8, 'pass', 11),
  ]);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.criteriaResults[0].observed, 31.2);
});

test('same-timestamp evidence keeps the newest stored observation', () => {
  const task = baseTask({ acceptanceCriteria: [{ metric: 'camera_fps', expected: '>=30' }] });
  // Evidence store results are newest first, even when two writes share a millisecond.
  const repaired = evaluateAcceptance(task, [
    ev('camera_fps', 31, 'pass', 10),
    ev('camera_fps', 17, 'fail', 10),
  ]);
  assert.equal(repaired.verdict, 'pass');
  const regressed = evaluateAcceptance(task, [
    ev('camera_fps', 17, 'fail', 10),
    ev('camera_fps', 31, 'pass', 10),
  ]);
  assert.equal(regressed.verdict, 'fail');
});

test('string equality ==hi is a real verdict, not NO EVIDENCE', () => {
  const task = baseTask({
    acceptanceCriteria: [{ metric: 'marker', expected: '==hi' }],
  });
  const pass = evaluateAcceptance(task, [ev('marker', 'hi', 'pass', 1)]);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.criteriaResults[0].result, 'pass');
  const fail = evaluateAcceptance(task, [ev('marker', 'bye', 'fail', 2)]);
  assert.equal(fail.criteriaResults[0].result, 'fail');
  assert.match(taskDefineTool.description, /==hi/);
  assert.match(taskDefineTool.description, /numeric >= <= > < == !=/);
  const criteria = taskDefineTool.inputSchema.properties?.acceptance_criteria;
  assert.match(String(criteria?.description ?? ''), /==hi/);
});

test('raw observations remain usable with independent task expectations', () => {
  const task = baseTask({ acceptanceCriteria: [{ metric: 'value', expected: '==hello world' }] });
  const raw = ev('value', 'hello world', 'inconclusive', 10);
  assert.equal(evaluateAcceptance(task, [raw]).verdict, 'pass');
  const inconclusiveCheck = { ...raw, expected: 'exists', automaticResult: 'inconclusive' };
  assert.equal(evaluateAcceptance(task, [inconclusiveCheck]).verdict, 'pass');

  const numericTask = baseTask({ acceptanceCriteria: [{ metric: 'fps', expected: '>=30' }] });
  const stricterEvidence = {
    ...ev('fps', 35, 'fail', 10),
    expected: '>=40',
    automaticResult: 'fail',
    explicitResult: 'fail',
  };
  assert.equal(evaluateAcceptance(numericTask, [stricterEvidence]).verdict, 'pass');

  const policyTask = baseTask({
    acceptanceCriteria: [{ metric: 'device_policy', expected: 'contains allow' }],
  });
  const policy = {
    ...ev('device_policy', 'reversible:allow', 'pass', 10),
    source: 'device_policy',
    expected: 'auto-allow',
  };
  assert.equal(evaluateAcceptance(policyTask, [policy]).verdict, 'pass');
});

test('missing observation cannot satisfy a task criterion', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-missing-observation-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    {
      goal: 'verify the device log',
      acceptance_criteria: [{ metric: 'log', expected: 'not-contains CRITICAL' }],
    },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);

  const evidence = await recordEvidenceTool.execute(
    { task_id: taskId, metric: 'log', expected: 'not-contains CRITICAL', source: 'device_exec' },
    ctx
  );
  assert.match(evidence, /INCONCLUSIVE/);
  const verdict = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(verdict, /: FAIL/);
  assert.match(verdict, /NO EVIDENCE\] log/);
});

test('null observation remains missing through evidence input normalization', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-null-observation-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    {
      goal: 'verify the device log',
      acceptance_criteria: [{ metric: 'log', expected: 'not-contains CRITICAL' }],
    },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);
  const input = {
    task_id: taskId,
    metric: 'log',
    expected: 'not-contains CRITICAL',
    observed: null,
    source: 'device_exec',
  };
  const normalized = recordEvidenceTool.normalizeInput(input, ctx);
  const evidence = await recordEvidenceTool.execute(normalized, ctx);
  assert.match(evidence, /INCONCLUSIVE/);
  const verdict = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(verdict, /: FAIL/);
});

test('conflicting evidence blocks acceptance until a consistent remeasurement', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-conflicting-evidence-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    {
      goal: 'verify frame rate',
      acceptance_criteria: [{ metric: 'fps', expected: '>=30' }],
    },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);

  const conflicting = await recordEvidenceTool.execute(
    {
      task_id: taskId,
      metric: 'fps',
      expected: '>=30',
      observed: '31',
      result: 'fail',
      source: 'test',
    },
    ctx
  );
  assert.match(conflicting, /INCONCLUSIVE/);
  const [stored] = await listEvidenceRecords(workspace);
  assert.equal(stored.explicitResult, 'fail');
  assert.equal(stored.automaticResult, 'pass');
  const blocked = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(blocked, /: FAIL/);
  assert.match(blocked, /NO EVIDENCE\] fps/);

  const repaired = await recordEvidenceTool.execute(
    { task_id: taskId, metric: 'fps', expected: '>=30', observed: '32', source: 'test' },
    ctx
  );
  assert.match(repaired, /PASS/);
  const accepted = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(accepted, /: PASS/);
});

test('explicitly conflicting evidence stays inconclusive when its original check is ambiguous', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-ambiguous-evidence-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    {
      goal: 'verify the reported value',
      acceptance_criteria: [{ metric: 'value', expected: '==hello world' }],
    },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);
  const conflicting = await recordEvidenceTool.execute(
    {
      task_id: taskId,
      metric: 'value',
      expected: 'exists',
      observed: 'hello world',
      result: 'fail',
      source: 'test',
    },
    ctx
  );
  assert.match(conflicting, /INCONCLUSIVE/);
  const blocked = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(blocked, /: FAIL/);
  assert.match(blocked, /NO EVIDENCE\] value/);
});

test('explicit failure without an expectation cannot become a passing criterion', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-explicit-failure-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    { goal: 'verify frame rate', acceptance_criteria: [{ metric: 'fps', expected: '>=30' }] },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);
  const evidence = await recordEvidenceTool.execute(
    { task_id: taskId, metric: 'fps', observed: '31', result: 'fail', source: 'human' },
    ctx
  );
  assert.match(evidence, /FAIL/);
  const verdict = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(verdict, /: FAIL/);
  assert.match(verdict, /NO EVIDENCE\] fps/);
});

test('other tasks cannot hide evidence needed for acceptance', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-evidence-history-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    { goal: 'verify frame rate', acceptance_criteria: [{ metric: 'fps', expected: '>=30' }] },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);
  await recordEvidenceTool.execute(
    { task_id: taskId, metric: 'fps', observed: '31', source: 'test' },
    ctx
  );
  const unrelated = Array.from({ length: 1001 }, (_, index) =>
    JSON.stringify({
      evidenceId: `other_${index}`,
      taskId: 'other_task',
      source: 'test',
      metric: 'other_metric',
      observed: 0,
      result: 'inconclusive',
      timestamp: Date.now() + index,
    })
  ).join('\n');
  await fs.appendFile(path.join(workspace, '.moss', 'evidence.jsonl'), `${unrelated}\n`);
  const verdict = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(verdict, /: PASS/);
  assert.match(verdict, /fps — expected >=30 observed 31/);
});

test('older task remains addressable after more than fifty tasks', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-history-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);
  const defined = await taskDefineTool.execute(
    { goal: 'verify frame rate', acceptance_criteria: [{ metric: 'fps', expected: '>=30' }] },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId);
  await recordEvidenceTool.execute(
    { task_id: taskId, metric: 'fps', observed: '31', source: 'test' },
    ctx
  );
  const [original] = await listTaskRecords(workspace);
  const later = Array.from({ length: 51 }, (_, index) =>
    JSON.stringify({ ...original, taskId: `later_${index}`, goal: `later task ${index}` })
  ).join('\n');
  await fs.appendFile(path.join(workspace, '.moss', 'tasks.jsonl'), `${later}\n`);
  assert.equal((await listTaskRecords(workspace)).length, 50, 'public list remains bounded');
  const verdict = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(verdict, /: PASS/);
});

test('task_define → record_evidence → task_acceptance full lifecycle', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  const badCriteria = await taskDefineTool.execute(
    { goal: 'g', acceptance_criteria: [{ metric: 'x' }] },
    ctx
  );
  assert.match(badCriteria, /^Error: task_define: criterion "x" needs an expectation/);

  const defined = await taskDefineTool.execute(
    {
      goal: 'person-stop behavior on RDK X5',
      target_device: 'rdk-x5-001',
      acceptance_criteria: [
        { metric: 'camera_fps', expected: '>=30', description: 'perception throughput' },
        { metric: 'stop_distance_m', expected: '<=1' },
      ],
      verification_plan: ['run perception on device', 'measure fps', 'measure stop distance'],
    },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)?.[0];
  assert.ok(taskId, 'task id surfaced to the model');
  assert.match(defined, /acceptance criteria \(2\)/);
  assert.match(defined, /camera_fps >=30/);

  // Acceptance before evidence: FAIL with no-evidence — the agent cannot
  // self-certify.
  const before = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(before, /: FAIL/);
  assert.match(before, /NO EVIDENCE\] camera_fps/);
  assert.match(before, /FINAL: not accepted/);

  // Record a failing measurement, then the repaired one.
  await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '17.3',
      source: 'device_exec',
      task_id: taskId,
    },
    ctx
  );
  const midVerdict = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(midVerdict, /: FAIL/);

  await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '31.2',
      source: 'device_exec',
      task_id: taskId,
    },
    ctx
  );
  await recordEvidenceTool.execute(
    {
      metric: 'stop_distance_m',
      expected: '<=1',
      observed: '0.9',
      source: 'device_exec',
      task_id: taskId,
    },
    ctx
  );
  const accepted = await taskAcceptanceTool.execute({ task_id: taskId }, ctx);
  assert.match(accepted, /: PASS/);
  assert.match(accepted, /camera_fps — expected >=30 observed 31\.2/);
  assert.match(accepted, /FINAL: PASS — acceptance criteria met/);

  const tasks = await listTaskRecords(workspace);
  assert.equal(tasks[0].taskId, taskId);
  assert.equal(tasks[0].status, 'accepted', 'status flips to accepted on pass');

  const verdicts = await fs.readFile(path.join(workspace, '.moss', 'acceptance.jsonl'), 'utf8');
  const lines = verdicts.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 3, 'every acceptance evaluation is recorded');
  assert.equal(JSON.parse(lines[0]).verdict, 'fail');

  const unknown = await taskAcceptanceTool.execute({ task_id: 'task_nope' }, ctx);
  assert.match(unknown, /^Error: task_acceptance: task task_nope not found/);
});

test('task_define: redefine updates in place and validates references', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-redef-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  const first = await taskDefineTool.execute(
    { goal: 'v1', acceptance_criteria: [{ metric: 'm', expected: '>=1' }] },
    ctx
  );
  const taskId = /task_\w+/.exec(first)[0];
  const redefined = await taskDefineTool.execute(
    { task_id: taskId, goal: 'v2', acceptance_criteria: [{ metric: 'm', expected: '>=2' }] },
    ctx
  );
  assert.match(redefined, /v2/);
  assert.match(redefined, /m >=2/);

  const tasks = await listTaskRecords(workspace);
  assert.equal(tasks.length, 1, 'same task id, no duplicate');
  assert.equal(tasks[0].goal, 'v2');

  const badRef = await taskDefineTool.execute(
    { task_id: 'task_missing', goal: 'x', acceptance_criteria: [{ metric: 'm', expected: '>=1' }] },
    ctx
  );
  assert.match(badRef, /^Error: task_define: task_id task_missing not found/);
});

test('ordinary chat cannot open a task contract or record evidence', async () => {
  const denied = { workspaceDir: '/tmp/moss-task-deny', sessionKey: 'chat', taskContracts: 'deny' };
  const defined = await taskDefineTool.execute(
    {
      goal: 'what is the board status?',
      acceptance_criteria: [{ metric: 'up', expected: '==true' }],
    },
    denied
  );
  assert.match(defined, /only created for \/goal or an explicit task/);
  const recorded = await recordEvidenceTool.execute(
    { metric: 'up', source: 'chat', observed: true, result: 'pass' },
    denied
  );
  assert.match(recorded, /do not record evidence/);
});

test('task tools: metadata is runtime_state, plan-mode allowed', () => {
  for (const tool of [taskDefineTool, taskAcceptanceTool]) {
    assert.equal(tool.metadata.sideEffectClass, 'runtime_state');
    assert.equal(tool.metadata.planMode, 'allow');
  }
});
