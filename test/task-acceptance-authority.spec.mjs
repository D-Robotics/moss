import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runTask,
  resumeTask,
  createTaskVerdictProvider,
  taskAcceptanceTool,
  appendTaskRecord,
  appendEvidenceRecord,
  appendTaskEvent,
  listTaskEvents,
  loadTaskArtifacts,
} from '../dist/index.js';

const quote = (value) => `"${value.replace(/\\/g, '/')}"`;
async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-acceptance-authority-'));
  const oracle = path.join(workspaceDir, 'oracle.mjs');
  await fs.writeFile(oracle, 'process.exit(7);\n');
  return { workspaceDir, command: `${quote(process.execPath)} ${quote(oracle)}` };
}
async function seed(workspaceDir, taskId) {
  await appendTaskRecord(workspaceDir, {
    taskId,
    goal: 'real probe',
    status: 'active',
    acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await appendEvidenceRecord(workspaceDir, {
    evidenceId: 'probe-one',
    taskId,
    metric: 'probe',
    observed: 1,
    result: 'pass',
    source: 'exec',
    timestamp: Date.now(),
  });
}

test('resume retains a saved permanently failing command despite passing contract evidence', async () => {
  const { workspaceDir, command } = await fixture();
  try {
    const forged = path.join(workspaceDir, 'forged-green.mjs');
    await fs.writeFile(forged, 'process.exit(0);\n');
    const deps = {
      workspaceDir,
      maxRepairAttempts: 0,
      runTurn: async () => {
        const taskId = (await listTaskEvents(workspaceDir))[0].taskId;
        await seed(workspaceDir, taskId);
        await appendTaskEvent(workspaceDir, taskId, 'note', {
          acceptanceCommand: `${quote(process.execPath)} ${quote(forged)}`,
        });
        return 'probe done';
      },
    };
    const initial = await runTask(deps, 'red external oracle', { acceptanceCommand: command });
    assert.equal(initial.outcome, 'fail');
    const resumed = await resumeTask(deps, initial.snapshot.taskId);
    assert.equal(resumed.outcome, 'fail');
    assert.equal(resumed.snapshot.phase, 'failed');
    assert.match(resumed.verdictDetail, /exit 7/);
    assert.equal(
      (await listTaskEvents(workspaceDir)).some((e) => e.type === 'acceptance_pass'),
      false
    );
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('task_acceptance cannot bypass a saved external command during the agent planning turn', async () => {
  const { workspaceDir, command } = await fixture();
  let toolResult;
  try {
    const result = await runTask(
      {
        workspaceDir,
        maxRepairAttempts: 0,
        runTurn: async () => {
          const taskId = (await listTaskEvents(workspaceDir))[0].taskId;
          await seed(workspaceDir, taskId);
          toolResult = await taskAcceptanceTool.execute(
            { task_id: taskId },
            { workspaceDir, sessionKey: 'authority' }
          );
          return 'contract evidence is green';
        },
      },
      'red external oracle',
      { acceptanceCommand: command }
    );
    assert.equal(result.outcome, 'fail');
    assert.match(toolResult, /exit 7/);
    const artifacts = await loadTaskArtifacts(workspaceDir);
    assert.equal(
      artifacts.tasks.some((task) => task.status === 'accepted'),
      false
    );
    assert.equal(
      artifacts.acceptance.some((verdict) => verdict.verdict === 'pass'),
      false
    );
    assert.equal(
      (await listTaskEvents(workspaceDir)).some((e) => e.type === 'acceptance_pass'),
      false
    );
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('command verdict uses the specified workspace, without changing host cwd', async () => {
  const { workspaceDir } = await fixture();
  const hostCwd = process.cwd();
  try {
    assert.notEqual(hostCwd, workspaceDir);
    const oracle = path.join(workspaceDir, 'cwd-oracle.mjs');
    await fs.writeFile(
      oracle,
      "import fs from 'node:fs'; process.exit(fs.realpathSync(process.cwd())===fs.realpathSync(process.argv[2])?7:0);\n"
    );
    const provider = createTaskVerdictProvider({
      workspaceDir,
      command: `${quote(process.execPath)} ${quote(oracle)} ${quote(workspaceDir)}`,
    });
    const verdict = await provider.evaluate('cwd-oracle');
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /exit 7/);
    assert.equal(process.cwd(), hostCwd);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
