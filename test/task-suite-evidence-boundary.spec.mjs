import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendTaskRecord,
  appendEvidenceRecord,
  listEvidenceRecords,
  createTaskVerdictProvider,
} from '../dist/index.js';
import { inAcceptanceScope } from '../dist/core/task/acceptance-commit-scope.js';
import { withTaskEventLock } from '../dist/core/task/task-store.js';
import { recordHarnessSuiteEvidence } from '../dist/core/task/suite-evidence.js';

async function seed(workspaceDir) {
  await appendTaskRecord(workspaceDir, {
    taskId: 'one',
    goal: 'real suite',
    status: 'active',
    acceptanceCriteria: [{ metric: 'tests_pass', expected: '==true' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await appendEvidenceRecord(workspaceDir, {
    evidenceId: 'initial',
    taskId: 'one',
    metric: 'tests_pass',
    observed: true,
    result: 'pass',
    source: 'exec',
    timestamp: Date.now(),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const cancel of [false, true]) {
  test(
    cancel
      ? 'cancelled queued suite evidence cannot overwrite a prior real PASS'
      : 'an ended tool scope cannot dispatch queued suite evidence without a signal',
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-suite-boundary-'));
      const owned = deferred();
      const gate = deferred();
      const control = new AbortController();
      let hold;
      let evidence;
      try {
        await seed(workspaceDir);
        hold = withTaskEventLock(workspaceDir, async () => {
          owned.resolve();
          await gate.promise;
        });
        await owned.promise;
        const boundaryPromise = inAcceptanceScope(workspaceDir, async () => {
          evidence = recordHarnessSuiteEvidence({
            workspaceDir,
            taskId: 'one',
            source: 'acceptance_command',
            testsPassed: false,
            ...(cancel ? { signal: control.signal } : {}),
          }).then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          if (cancel) {
            control.abort(new Error('operator cancelled queued suite'));
            // Keep this scope open until the queued call settles: this case
            // specifically proves cancellation, independently of the closed guard.
            await evidence;
          }
          return 'tool ended';
        });
        if (!cancel) await boundaryPromise;
        const before = await fs.readFile(
          path.join(workspaceDir, '.moss', 'evidence.jsonl'),
          'utf8'
        );
        assert.equal(before.trim().split('\n').length, 1);
        gate.resolve();
        await hold;
        assert.equal(
          (await boundaryPromise).committed,
          undefined,
          'evidence never registers native commit priority'
        );
        const result = await evidence;
        if (cancel) assert.match(String(result.error), /operator cancelled queued suite/);
        else assert.equal(result.value, 0);
        const rows = await listEvidenceRecords(workspaceDir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].evidenceId, 'initial');
        assert.equal(rows[0].observed, true);
        await assert.rejects(fs.stat(path.join(workspaceDir, '.moss', 'evidence.jsonl.pending')), {
          code: 'ENOENT',
        });
        assert.equal(
          await recordHarnessSuiteEvidence({
            workspaceDir,
            taskId: 'one',
            source: 'acceptance_command',
            testsPassed: false,
          }),
          1,
          'a fresh live caller can record the actual failing suite'
        );
        assert.equal((await listEvidenceRecords(workspaceDir))[0].observed, false);
      } finally {
        gate.resolve();
        await hold;
        await evidence;
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    }
  );
}

test('cancelling a real command cannot append a late failing suite after the tool boundary', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-command-evidence-cancel-'));
  const control = new AbortController();
  const owned = deferred();
  const gate = deferred();
  let hold;
  let evaluated;
  try {
    await seed(workspaceDir);
    const oracle = path.join(workspaceDir, 'oracle.mjs');
    await fs.writeFile(
      oracle,
      "import fs from 'node:fs'; fs.writeFileSync('started','yes'); setTimeout(()=>process.exit(0),20000);\n"
    );
    const quote = (value) => `"${value.replace(/\\/g, '/')}"`;
    const provider = createTaskVerdictProvider({
      workspaceDir,
      command: `${quote(process.execPath)} ${quote(oracle)}`,
    });
    const boundary = inAcceptanceScope(workspaceDir, async () => {
      evaluated = provider.evaluate('one', control.signal).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await new Promise((resolve) =>
        control.signal.addEventListener('abort', resolve, { once: true })
      );
      return 'tool cancelled';
    });
    for (let i = 0; i < 200; i += 1) {
      if (
        await fs.stat(path.join(workspaceDir, 'started')).then(
          () => true,
          () => false
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await fs.readFile(path.join(workspaceDir, 'started'), 'utf8'), 'yes');
    hold = withTaskEventLock(workspaceDir, async () => {
      owned.resolve();
      await gate.promise;
    });
    await owned.promise;
    control.abort(new Error('operator cancelled real oracle'));
    assert.equal((await boundary).committed, undefined);
    gate.resolve();
    await hold;
    assert.match(String((await evaluated).error), /operator cancelled real oracle/);
    const rows = await listEvidenceRecords(workspaceDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observed, true);
    await assert.rejects(fs.stat(path.join(workspaceDir, '.moss', 'acceptance.jsonl')), {
      code: 'ENOENT',
    });
  } finally {
    control.abort();
    gate.resolve();
    await hold;
    await evaluated;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
