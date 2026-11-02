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
import {
  appendEvidenceRecord,
  appendTaskRecord,
  listEvidenceRecords,
} from '../dist/core/task-runtime/artifacts.js';
import { MossAgent, InMemorySessionStore } from '../dist/index.js';
import { createAgentTurnRunner } from '../dist/core/task/agent-turn.js';
import { createDraftTask } from '../dist/core/task/task-store.js';
import { evaluateAcceptance } from '../dist/contracts/task.js';
import { runTestsTool, verifyFixTool } from '../dist/tools/harness-tools.js';
import { taskAcceptanceTool } from '../dist/tools/task-tools.js';
import { runProcess } from '../dist/utils/run-process.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

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

for (const method of ['streamChat', 'chat']) {
  test(`${method} task turn records its real test run on the running task rather than a newer live task`, async (t) => {
    const dir = await fs.realpath(await workspace());
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(dir, 'passing.spec.mjs'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('real check', () => assert.equal(1 + 1, 2));\n"
    );
    const provider = createMockTranscriptProvider('local', 'local', [
      { toolCalls: [{ name: 'run_tests', input: { file: 'passing.spec.mjs' } }] },
      { toolCalls: [{ name: 'task_acceptance', input: {} }] },
      { text: 'Tests ran.' },
    ]);
    const agent = new MossAgent({
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      model: 'local',
      workspaceDir: dir,
      domainPrompt: false,
      enableFollowUpGuard: false,
      enableCompaction: false,
      hooks: { onBeforeToolExec: async () => ({ approved: true }) },
    });
    agent.tools.register(runTestsTool);
    agent.tools.register(taskAcceptanceTool);
    const turnAgent = method === 'chat' ? { chat: agent.chat.bind(agent) } : agent;
    const turn = createAgentTurnRunner(turnAgent, 'current-task');
    let taskB;
    const result = await runTask(
      {
        workspaceDir: dir,
        maxTurns: 1,
        maxRepairAttempts: 0,
        runTurn: async (prompt, phase, context) => {
          const taskA = (await listTaskEvents(dir))[0].taskId;
          await define(dir, taskA, 'task A', [
            { metric: 'tests_pass', expected: '==true', required: true },
          ]);
          taskB = await createDraftTask(dir, 'task B');
          taskB = {
            ...taskB,
            status: 'active',
            updatedAt: Date.now() + 10_000,
            acceptanceCriteria: [{ metric: 'tests_pass', expected: '==true', required: true }],
          };
          await appendTaskRecord(dir, taskB);
          return turn(prompt, phase, context);
        },
      },
      'task A'
    );
    const evidence = await listEvidenceRecords(dir, 20);
    assert.equal(evidence.length, 1, 'the real test run produced one evidence record');
    assert.equal(evidence[0].taskId, result.snapshot.taskId);
    assert.equal(result.outcome, 'pass');
    assert.equal(evaluateAcceptance(taskB, evidence).verdict, 'fail');
  });
}

test('a missing host-selected task cannot receive or redirect suite evidence', async (t) => {
  const dir = await fs.realpath(await workspace());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const live = await createDraftTask(dir, 'unrelated live task');
  await define(dir, live.taskId, live.goal, [
    { metric: 'tests_pass', expected: '==true', required: true },
  ]);
  await fs.writeFile(
    path.join(dir, 'passing.spec.mjs'),
    "import test from 'node:test'; test('real check', () => {});\n"
  );
  const output = await runTestsTool.execute(
    { file: 'passing.spec.mjs' },
    { workspaceDir: dir, sessionKey: 'missing', goalExecWait: true, taskId: 'missing-task' }
  );
  assert.match(output, /tests_pass=true/);
  assert.deepEqual(await listEvidenceRecords(dir, 20), []);
});

test('implicit acceptance uses the current task and an explicit task_id still wins', async (t) => {
  const dir = await fs.realpath(await workspace());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const taskA = await createDraftTask(dir, 'task A');
  await define(dir, taskA.taskId, taskA.goal, [
    { metric: 'tests_pass', expected: '==true', required: true },
  ]);
  await appendEvidenceRecord(dir, {
    evidenceId: 'a-real-test',
    taskId: taskA.taskId,
    metric: 'tests_pass',
    source: 'run_tests',
    observed: true,
    result: 'pass',
    timestamp: Date.now(),
  });
  const taskB = await createDraftTask(dir, 'task B');
  await appendTaskRecord(dir, {
    ...taskB,
    status: 'active',
    updatedAt: Date.now() + 10_000,
    acceptanceCriteria: [{ metric: 'tests_pass', expected: '==true', required: true }],
  });
  const ctx = { workspaceDir: dir, sessionKey: 'accept', taskId: taskA.taskId };
  assert.match(
    await taskAcceptanceTool.execute({}, ctx),
    new RegExp(`Task acceptance \\(${taskA.taskId}\\): PASS`)
  );
  assert.match(
    await taskAcceptanceTool.execute({ task_id: taskB.taskId }, ctx),
    new RegExp(`Task acceptance \\(${taskB.taskId}\\): FAIL`)
  );
  assert.match(
    await taskAcceptanceTool.execute({}, { ...ctx, taskId: 'missing-task' }),
    /task missing-task not found/
  );
});

test('verify_fix records all real checks on the current task', async (t) => {
  const dir = await fs.realpath(await workspace());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const taskA = await createDraftTask(dir, 'task A');
  await createDraftTask(dir, 'newer task B');
  await fs.writeFile(
    path.join(dir, 'check.test.mjs'),
    "import test from 'node:test'; test('check', () => {});\n"
  );
  // A nested node --test otherwise inherits the parent test runner's IPC mode.
  const inheritedContext = process.env.NODE_TEST_CONTEXT;
  const inheritedWorkerId = process.env.NODE_TEST_WORKER_ID;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_WORKER_ID;
  let result;
  try {
    result = await verifyFixTool.execute(
      {
        build_command: 'node -e "process.exit(0)"',
        typecheck_command: 'node -e "process.exit(0)"',
        test_command: 'node --test check.test.mjs',
      },
      { workspaceDir: dir, sessionKey: 'verify', goalExecWait: true, taskId: taskA.taskId }
    );
  } finally {
    if (inheritedContext !== undefined) process.env.NODE_TEST_CONTEXT = inheritedContext;
    if (inheritedWorkerId !== undefined) process.env.NODE_TEST_WORKER_ID = inheritedWorkerId;
  }
  assert.match(result, /ALL PASSED/);
  const evidence = await listEvidenceRecords(dir, 20);
  assert.deepEqual(evidence.map((row) => row.metric).sort(), [
    'build_ok',
    'tests_pass',
    'typecheck_ok',
  ]);
  assert.ok(evidence.every((row) => row.taskId === taskA.taskId && row.observed === true));
});

test('offline task CLI accepts only the task that owns the real test evidence', async (t) => {
  const dir = await fs.realpath(await workspace());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const taskA = await createDraftTask(dir, 'CLI task A');
  const taskB = await createDraftTask(dir, 'CLI task B');
  const criteria = [{ metric: 'tests_pass', expected: '==true', required: true }];
  await define(dir, taskA.taskId, taskA.goal, criteria);
  await define(dir, taskB.taskId, taskB.goal, criteria);
  await fs.writeFile(
    path.join(dir, 'passing.spec.mjs'),
    "import test from 'node:test'; test('real check', () => {});\n"
  );
  assert.match(
    await runTestsTool.execute(
      { file: 'passing.spec.mjs' },
      { workspaceDir: dir, sessionKey: 'cli', taskId: taskA.taskId, goalExecWait: true }
    ),
    /tests_pass=true/
  );
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    MOSS_CONFIG_DIR: path.join(dir, 'config'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    OPENAI_API_KEY: 'offline-placeholder',
    MOSS_NO_TUI: '1',
    CI: '1',
  };
  const cli = path.resolve('bin/moss.cjs');
  const verify = (taskId) =>
    runProcess(process.execPath, {
      args: [
        cli,
        '-C',
        dir,
        '--provider',
        'openai',
        '--base-url',
        'http://127.0.0.1:9',
        '--model',
        'offline',
        'task',
        'verify',
        taskId,
      ],
      cwd: dir,
      env,
      timeout: 15000,
    });
  await assert.rejects(verify(taskB.taskId), (error) => {
    assert.equal(error.exitCode, 1, error.stderr);
    assert.match(`${error.stdout}\n${error.stderr}`, /NO EVIDENCE/);
    return true;
  });
  const accepted = await verify(taskA.taskId);
  assert.equal(accepted.exitCode, 0);
  assert.match(accepted.stdout, /PASS/);
});

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

test('suite evidence boolean true satisfies tests_pass == pass', async () => {
  const dir = await workspace();
  const { createDraftTask } = await import('../dist/core/task/task-store.js');
  const draft = await createDraftTask(dir, SMALL);
  await define(dir, draft.taskId, SMALL, [
    { metric: 'tests_pass', expected: '==pass', required: true },
  ]);
  const wrote = await recordHarnessSuiteEvidence({
    workspaceDir: dir,
    taskId: draft.taskId,
    source: 'run_tests',
    testsPassed: true,
    output: 'tests_pass=true',
  });
  assert.equal(wrote, 1);
  const records = await listEvidenceRecords(dir, 20);
  assert.equal(records[0].metric, 'tests_pass');
  assert.equal(records[0].observed, true);
  const judged = await evaluateContractAcceptance(dir, draft.taskId);
  assert.equal(judged.verdict.verdict, 'pass', judged.verdict.criteriaResults[0].explanation);
  assert.equal(judged.verdict.criteriaResults[0].result, 'pass');

  const failDir = await workspace();
  const failed = await createDraftTask(failDir, SMALL);
  await define(failDir, failed.taskId, SMALL, [
    { metric: 'tests_pass', expected: '==passed', required: true },
  ]);
  await recordHarnessSuiteEvidence({
    workspaceDir: failDir,
    taskId: failed.taskId,
    source: 'run_tests',
    testsPassed: false,
    output: 'tests_pass=false',
  });
  const rejected = await evaluateContractAcceptance(failDir, failed.taskId);
  assert.equal(rejected.verdict.verdict, 'fail');
  assert.equal(rejected.verdict.criteriaResults[0].observed, false);

  const synonymDir = await workspace();
  const synonym = await createDraftTask(synonymDir, SMALL);
  await define(synonymDir, synonym.taskId, SMALL, [
    { metric: 'tests_pass', expected: '==failed', required: true },
  ]);
  await recordHarnessSuiteEvidence({
    workspaceDir: synonymDir,
    taskId: synonym.taskId,
    source: 'run_tests',
    testsPassed: false,
    output: 'tests_pass=false',
  });
  const matched = await evaluateContractAcceptance(synonymDir, synonym.taskId);
  assert.equal(matched.verdict.verdict, 'pass');
});

test('ordinary chat and streamChat cannot attach real test runs to a live task', async (t) => {
  const dir = await fs.realpath(await workspace());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await createDraftTask(dir, 'unrelated task');
  await fs.writeFile(
    path.join(dir, 'check.test.mjs'),
    "import test from 'node:test'; test('check', () => {});\n"
  );
  for (const stream of [false, true]) {
    const provider = createMockTranscriptProvider('local', 'local', [
      { toolCalls: [{ name: 'run_tests', input: { file: 'check.test.mjs' } }] },
      { text: 'Tests ran.' },
    ]);
    const agent = new MossAgent({
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      model: 'local',
      workspaceDir: dir,
      domainPrompt: false,
      enableFollowUpGuard: false,
      enableCompaction: false,
      hooks: { onBeforeToolExec: async () => ({ approved: true }) },
    });
    agent.tools.register(runTestsTool);
    if (stream) {
      const events = [];
      for await (const event of agent.streamChat('ordinary-stream', 'Run tests', {
        taskFlow: false,
      }))
        events.push(event);
      assert.ok(
        events.some((event) => event.type === 'tool_end' && event.toolName === 'run_tests')
      );
    } else {
      const response = await agent.chat('ordinary-chat', 'Run tests', { taskFlow: false });
      assert.ok(response.toolResults.some((item) => /tests_pass=true/.test(item.content)));
    }
    assert.deepEqual(await listEvidenceRecords(dir, 20), []);
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
