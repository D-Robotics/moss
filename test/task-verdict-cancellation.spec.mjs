import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import {
  runTask,
  createContractVerdictProvider,
  appendTaskRecord,
  appendEvidenceRecord,
  listTaskRecords,
  listTaskEvents,
  loadTaskArtifacts,
} from '../dist/index.js';

async function seed(workspaceDir, taskId, evidence = true) {
  await appendTaskRecord(workspaceDir, {
    taskId,
    goal: 'Probe one',
    acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (evidence)
    await appendEvidenceRecord(workspaceDir, {
      evidenceId: 'probe-evidence',
      taskId,
      metric: 'probe',
      expected: '==1',
      observed: 1,
      result: 'pass',
      source: 'exec',
      timestamp: Date.now(),
    });
}

test('contract provider aborts before persistence, including cancellation during evidence IO', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-verdict-cancel-'));
  const originalRead = fs.readFile;
  try {
    await seed(workspaceDir, 'fixture');
    const provider = createContractVerdictProvider(workspaceDir);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(provider.evaluate('fixture', alreadyAborted.signal), {
      name: 'AbortError',
    });
    const duringRead = new AbortController();
    fs.readFile = async function (file, ...args) {
      const body = await originalRead.call(this, file, ...args);
      if (String(file).endsWith('evidence.jsonl')) duringRead.abort();
      return body;
    };
    await assert.rejects(provider.evaluate('fixture', duringRead.signal), { name: 'AbortError' });
    fs.readFile = originalRead;
    const artifacts = await loadTaskArtifacts(workspaceDir);
    assert.equal(artifacts.acceptance.length, 0, 'cancelled evaluation cannot persist a PASS');
    assert.equal(artifacts.tasks[0].status, 'active');
    const successful = await provider.evaluate('fixture');
    assert.equal(successful.passed, true, 'the same real evidence passes without cancellation');
  } finally {
    fs.readFile = originalRead;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

for (const phase of ['planning', 'executing']) {
  test(`cancellation while ${phase} verdict awaits outranks a returned PASS`, async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-engine-cancel-'));
    const controller = new AbortController();
    const phases = [];
    try {
      const result = await runTask(
        {
          workspaceDir,
          signal: controller.signal,
          runTurn: async (_prompt, context) => {
            phases.push(context);
            const taskId = (await listTaskEvents(workspaceDir))[0].taskId;
            await seed(workspaceDir, taskId, context === phase);
            return { text: 'fixture turn', stopReason: 'stop' };
          },
          verdictProvider: {
            source: 'contract',
            evaluate: async (taskId, signal) => {
              assert.equal(signal, controller.signal);
              await Promise.resolve();
              controller.abort();
              return {
                taskId,
                passed: true,
                source: 'contract',
                detail: 'probe passed after cancellation',
              };
            },
          },
        },
        'Probe one'
      );
      assert.equal(result.outcome, 'aborted');
      assert.equal(result.snapshot.phase, 'failed');
      assert.equal(phases.length, phase === 'planning' ? 1 : 2);
      const events = await listTaskEvents(workspaceDir);
      assert.equal(
        events.some((event) => event.type === 'acceptance_pass'),
        false
      );
      assert.equal(
        (await listTaskRecords(workspaceDir)).some((task) => task.status === 'accepted'),
        false
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
}

for (const fails of [false, true]) {
  test(`cancellation during actual PASS append ${fails ? 'failure cannot accept' : 'success keeps durable prior acceptance'}`, async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-commit-cancel-'));
    const controller = new AbortController();
    const originalAppend = fs.appendFile;
    let intercepted = false;
    try {
      fs.appendFile = async function (file, ...args) {
        if (String(file).endsWith('acceptance.jsonl')) {
          intercepted = true;
          await Promise.resolve();
          controller.abort();
          if (fails) throw new Error('fixture acceptance IO failed');
        }
        return originalAppend.call(this, file, ...args);
      };
      const result = await runTask(
        {
          workspaceDir,
          signal: controller.signal,
          runTurn: async () => {
            await seed(workspaceDir, (await listTaskEvents(workspaceDir))[0].taskId);
            return 'probe done';
          },
        },
        'Probe one'
      );
      assert.equal(intercepted, true, 'the real filesystem append was gated');
      const artifacts = await loadTaskArtifacts(workspaceDir);
      const events = await listTaskEvents(workspaceDir);
      assert.equal(result.outcome, fails ? 'aborted' : 'pass');
      assert.equal(result.snapshot.phase, fails ? 'failed' : 'accepted');
      assert.equal(
        artifacts.tasks.some((task) => task.status === 'accepted'),
        !fails
      );
      assert.equal(
        events.some((event) => event.type === 'acceptance_pass'),
        !fails
      );
      assert.equal(
        artifacts.acceptance.some((verdict) => verdict.verdict === 'pass'),
        !fails
      );
    } finally {
      fs.appendFile = originalAppend;
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
}

test('cancellation while waiting for the real task-event lock writes no accepted state', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-lock-cancel-'));
  const controller = new AbortController();
  const originalRead = fs.readFile;
  let waited = false;
  try {
    fs.readFile = async function (file, ...args) {
      const body = await originalRead.call(this, file, ...args);
      if (
        !waited &&
        String(file).endsWith('task-events.jsonl.lock') &&
        body === `${process.ppid}:external-fixture`
      ) {
        waited = true;
        controller.abort();
        await fs.unlink(file);
      }
      return body;
    };
    syncBuiltinESMExports();
    const result = await runTask(
      {
        workspaceDir,
        signal: controller.signal,
        runTurn: async () => {
          await seed(workspaceDir, (await listTaskEvents(workspaceDir))[0].taskId, false);
          return 'probe awaiting verification';
        },
        verdictProvider: {
          source: 'contract',
          evaluate: async (taskId) => {
            await fs.writeFile(
              path.join(workspaceDir, '.moss', 'task-events.jsonl.lock'),
              `${process.ppid}:external-fixture`,
              { flag: 'wx' }
            );
            return {
              taskId,
              passed: true,
              source: 'contract',
              detail: 'custom pass before lock wait',
            };
          },
        },
      },
      'Probe one'
    );
    assert.equal(waited, true, 'acceptance encountered the existing lock');
    assert.equal(result.outcome, 'aborted');
    assert.equal(result.snapshot.phase, 'failed');
    assert.equal(
      (await listTaskEvents(workspaceDir)).some((event) => event.type === 'acceptance_pass'),
      false
    );
    assert.equal(
      (await listTaskRecords(workspaceDir)).some((task) => task.status === 'accepted'),
      false
    );
  } finally {
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
