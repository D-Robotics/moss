import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runTask,
  listTaskEvents,
  appendTaskRecord,
  appendEvidenceRecord,
  createContractVerdictProvider,
  loadTaskArtifacts,
} from '../dist/index.js';

test('native acceptance inside the planning turn emits accepted progress without another commit or turn', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-planning-progress-'));
  const phases = [];
  let turns = 0;
  try {
    const result = await runTask(
      {
        workspaceDir,
        onProgress: (progress) => phases.push(progress.phase),
        runTurn: async (_prompt, phase) => {
          turns++;
          assert.equal(phase, 'planning');
          const taskId = (await listTaskEvents(workspaceDir))[0].taskId;
          await appendTaskRecord(workspaceDir, {
            taskId,
            goal: 'one probe',
            status: 'active',
            acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const file = path.join(workspaceDir, 'probe.txt');
          await fs.writeFile(file, '1');
          await appendEvidenceRecord(workspaceDir, {
            evidenceId: 'real-file',
            taskId,
            metric: 'probe',
            observed: Number(await fs.readFile(file, 'utf8')),
            result: 'pass',
            source: 'exec',
            timestamp: Date.now(),
          });
          const verdict = await createContractVerdictProvider(workspaceDir).evaluate(taskId);
          assert.equal(verdict.passed, true);
          return verdict.detail;
        },
      },
      'one probe'
    );
    assert.equal(result.snapshot.phase, 'accepted');
    assert.equal(result.outcome, 'pass');
    assert.equal(turns, 1);
    assert.deepEqual(phases, ['planning', 'accepted']);
    const events = await listTaskEvents(workspaceDir, result.snapshot.taskId);
    assert.equal(events.filter((event) => event.type === 'acceptance_pass').length, 1);
    const artifacts = await loadTaskArtifacts(workspaceDir);
    assert.equal(artifacts.acceptance.filter((row) => row.verdict === 'pass').length, 1);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
