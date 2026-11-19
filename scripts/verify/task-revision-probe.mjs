import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (name) => import(pathToFileURL(path.join(root, 'dist', name)).href);
const [store, artifacts, revision, verdicts, engine, contracts, guards, tools] = await Promise.all([
  load('core/task/task-store.js'),
  load('core/task-runtime/artifacts.js'),
  load('core/task/task-revision.js'),
  load('core/task/verdict.js'),
  load('core/task/task-engine.js'),
  load('contracts/task.js'),
  load('core/task/task-execution-guard.js'),
  load('tools/task-tools.js'),
]);
const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-revision-'))
);
let checks = 0;

async function activeTask(name) {
  const workspaceDir = path.join(temporary, name);
  await fs.mkdir(workspaceDir);
  const task = await store.createDraftTask(workspaceDir, 'Read the X5 kernel', {
    constraints: ['read-only', 'reply in English'],
    targetDeviceId: 'x5',
  });
  await artifacts.appendTaskRecord(workspaceDir, {
    ...task,
    status: 'active',
    acceptanceCriteria: [{ metric: 'observed', expected: '== true' }],
    verificationPlan: ['read-only probe'],
  });
  await store.appendTaskEvent(workspaceDir, task.taskId, 'task_understood');
  await store.appendTaskEvent(workspaceDir, task.taskId, 'planning_started');
  await store.appendTaskEvent(workspaceDir, task.taskId, 'plan_ready', {
    steps: [{ stepId: 'old', title: 'Old background plan', status: 'pending' }],
  });
  await store.appendTaskEvent(workspaceDir, task.taskId, 'execution_started');
  return { workspaceDir, taskId: task.taskId };
}

async function evidence(fixture, taskRevision) {
  await artifacts.appendEvidenceRecord(fixture.workspaceDir, {
    evidenceId: `ev-${Math.random()}`,
    taskId: fixture.taskId,
    ...(taskRevision === undefined ? {} : { taskRevision }),
    source: 'executable-probe',
    metric: 'observed',
    observed: true,
    expected: '== true',
    result: 'pass',
    timestamp: Date.now(),
  });
}

try {
  assert.equal(
    contracts.evaluateAcceptance(
      {
        taskId: 'revision-test',
        revision: 1,
        acceptanceCriteria: [{ metric: 'ok', expected: '== true' }],
      },
      [
        {
          taskId: 'revision-test',
          evidenceId: 'old',
          metric: 'ok',
          observed: true,
          result: 'pass',
          timestamp: 0,
        },
      ]
    ).verdict,
    'fail',
    'unversioned evidence cannot satisfy a revised task'
  );
  checks++;

  const task = await activeTask('revised');
  await evidence(task);
  assert.equal(await verdicts.acceptanceAlreadySatisfied(task.workspaceDir, task.taskId), true);
  const change = {
    expectedRevision: 0,
    revisionId: 'user-12:1',
    sourceMessageIds: ['user-12'],
    changes: { goal: 'Read the X5 uptime' },
  };
  const revised = await revision.applyTaskRevision(task.workspaceDir, task.taskId, change);
  assert.equal(revised.revision, 1);
  assert.equal(revised.goal, change.changes.goal);
  assert.equal(revised.needsReplan, true);
  assert.deepEqual(revised.plan, []);
  const effective = (await artifacts.listTaskRecords(task.workspaceDir))[0];
  assert.deepEqual(effective.constraints, ['read-only', 'reply in English']);
  assert.equal(effective.targetDeviceId, 'x5');
  assert.equal(effective.originalGoal, 'Read the X5 kernel');
  assert.equal(await verdicts.acceptanceAlreadySatisfied(task.workspaceDir, task.taskId), false);
  assert.match(await store.buildTaskContextBrief(task.workspaceDir), /Read the X5 uptime/);
  assert.equal(
    (await revision.applyTaskRevision(task.workspaceDir, task.taskId, change)).revision,
    1
  );
  assert.equal(
    (await store.listTaskEvents(task.workspaceDir, task.taskId)).filter(
      (row) => row.type === 'task_revised'
    ).length,
    1
  );
  await assert.rejects(
    revision.applyTaskRevision(task.workspaceDir, task.taskId, { ...change, revisionId: 'stale' }),
    /expected revision/
  );
  await assert.rejects(
    store.tryAppendTaskEvent(task.workspaceDir, task.taskId, 'plan_step_updated', {
      taskRevision: 0,
      steps: [],
    }),
    guards.isTaskExecutionSupersededError
  );
  checks++;

  await tools.taskDefineTool.execute(
    {
      task_id: task.taskId,
      goal: revised.goal,
      acceptance_criteria: [{ metric: 'observed', expected: '== true' }],
    },
    { workspaceDir: task.workspaceDir }
  );
  assert.deepEqual(
    (await artifacts.listTaskRecords(task.workspaceDir))[0].constraints,
    effective.constraints
  );
  const refused = await tools.taskDefineTool.execute(
    {
      task_id: task.taskId,
      goal: 'old or unrelated goal',
      acceptance_criteria: [{ metric: 'observed', expected: '== true' }],
    },
    { workspaceDir: task.workspaceDir }
  );
  assert.match(refused, /authoritative/);
  assert.equal(
    (await store.getTaskStateSnapshot(task.workspaceDir, task.taskId)).goal,
    revised.goal
  );
  checks++;

  const phases = [];
  const resumed = await engine.resumeTask(
    {
      workspaceDir: task.workspaceDir,
      runTurn: async (_prompt, phase) => {
        phases.push(phase);
        await store.appendTaskEvent(task.workspaceDir, task.taskId, 'plan_ready', {
          taskRevision: 1,
          steps: [{ stepId: 'new', title: 'Use the corrected terminal', status: 'pending' }],
        });
        await evidence(task, 1);
        return 'planned and observed';
      },
    },
    task.taskId
  );
  assert.deepEqual(phases, ['planning']);
  assert.equal(resumed.outcome, 'pass');
  assert.equal(resumed.snapshot.revision, 1);
  assert.equal(resumed.snapshot.needsReplan, false);
  await assert.rejects(
    revision.applyTaskRevision(task.workspaceDir, task.taskId, {
      ...change,
      expectedRevision: 1,
      revisionId: 'after-pass',
    }),
    /new task/
  );
  checks++;

  const hold = await activeTask('pending-input');
  await evidence(hold);
  let evaluations = 0;
  const held = await engine.resumeTask(
    {
      workspaceDir: hold.workspaceDir,
      runTurn: async (_prompt, phase) => {
        assert.equal(phase, 'planning');
        return { text: 'Answer the capability question only.', stopReason: 'task_intent_hold' };
      },
      verdictProvider: {
        source: 'contract',
        evaluate: async () => {
          evaluations++;
          throw new Error('must not verify first');
        },
      },
    },
    hold.taskId,
    { replan: true }
  );
  assert.equal(held.outcome, 'blocked');
  assert.equal(held.snapshot.needsReplan, true);
  assert.equal(evaluations, 0);
  checks++;

  const late = await activeTask('stale-acceptance');
  await evidence(late);
  let obsolete = false;
  const originalOpen = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (String(file).endsWith('acceptance.jsonl.pending')) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync')
            return async () => {
              await target.sync();
              obsolete = true;
            };
          const member = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    }
    return handle;
  };
  try {
    await assert.rejects(
      guards.withTaskExecutionGuard(
        () => {
          if (obsolete) throw new Error('new user input');
        },
        () => verdicts.createContractVerdictProvider(late.workspaceDir).evaluate(late.taskId)
      ),
      guards.isTaskExecutionSupersededError
    );
  } finally {
    fs.open = originalOpen;
  }
  assert.deepEqual(await store.listAcceptanceVerdicts(late.workspaceDir, late.taskId), []);
  assert.notEqual(
    (await store.getTaskStateSnapshot(late.workspaceDir, late.taskId)).phase,
    'accepted'
  );
  checks++;

  const committed = await activeTask('dispatched-pass');
  await evidence(committed);
  obsolete = false;
  const originalAppend = fs.appendFile;
  fs.appendFile = async (file, ...args) => {
    if (String(file).endsWith('acceptance.jsonl')) obsolete = true;
    return originalAppend(file, ...args);
  };
  try {
    const passed = await guards.withTaskExecutionGuard(
      () => {
        if (obsolete) throw new Error('input arrived after PASS dispatch');
      },
      () =>
        verdicts.createContractVerdictProvider(committed.workspaceDir).evaluate(committed.taskId)
    );
    assert.equal(passed.passed, true);
    assert.equal(
      (await store.getTaskStateSnapshot(committed.workspaceDir, committed.taskId)).phase,
      'accepted'
    );
  } finally {
    fs.appendFile = originalAppend;
  }
  checks++;

  const drift = await activeTask('revision-during-verification');
  const stopped = await engine.resumeTask(
    {
      workspaceDir: drift.workspaceDir,
      runTurn: async () => {
        throw new Error('no repair turn expected');
      },
      verdictProvider: {
        source: 'contract',
        evaluate: async () => {
          await revision.applyTaskRevision(drift.workspaceDir, drift.taskId, {
            ...change,
            revisionId: 'during-verify',
          });
          return { taskId: drift.taskId, passed: true, source: 'contract', detail: 'stale PASS' };
        },
      },
    },
    drift.taskId
  );
  assert.equal(stopped.outcome, 'blocked');
  assert.equal(stopped.snapshot.revision, 1);
  assert.equal(
    (await store.listTaskEvents(drift.workspaceDir, drift.taskId)).some(
      (row) => row.type === 'acceptance_pass' || row.type === 'task_failed'
    ),
    false
  );
  checks++;

  console.log(JSON.stringify({ taskRevisionProbe: 'pass', checks }));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
