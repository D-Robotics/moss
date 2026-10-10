import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../dist/utils/run-process.js';
import {
  runTask,
  appendTaskRecord,
  appendEvidenceRecord,
  listTaskEvents,
  loadTaskArtifacts,
  createContractVerdictProvider,
  resumeTask,
} from '../dist/index.js';

for (const target of ['acceptance.jsonl', 'tasks.jsonl', 'task-events.jsonl']) {
  test(`a real ${target} fsync failure cannot be replayed as accepted`, async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-sync-'));
    const originalOpen = fs.open;
    let intercepted = false;
    try {
      fs.open = async function (file, flags, ...args) {
        const handle = await originalOpen.call(this, file, flags, ...args);
        if (String(file) === path.join(workspaceDir, '.moss', target) && flags === 'r+') {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            const visible = await fs.readFile(file, 'utf8');
            const accepted =
              target === 'acceptance.jsonl'
                ? visible.includes('"verdict":"pass"')
                : target === 'tasks.jsonl'
                  ? visible.includes('"status":"accepted"')
                  : visible.includes('"type":"acceptance_pass"');
            if (!intercepted && accepted) {
              intercepted = true;
              throw Object.assign(new Error('injected real acceptance fsync failure'), {
                code: 'EIO',
              });
            }
            return originalSync();
          };
        }
        return handle;
      };
      await assert.rejects(
        runTask(
          {
            workspaceDir,
            maxRepairAttempts: 0,
            runTurn: async () => {
              const taskId = (await listTaskEvents(workspaceDir))[0].taskId;
              await appendTaskRecord(workspaceDir, {
                taskId,
                goal: 'real one',
                status: 'active',
                acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              await appendEvidenceRecord(workspaceDir, {
                evidenceId: 'real-one',
                taskId,
                metric: 'probe',
                observed: 1,
                result: 'pass',
                source: 'exec',
                timestamp: Date.now(),
              });
              return 'real probe';
            },
          },
          'real one'
        ),
        /injected real acceptance fsync failure/
      );
      assert.equal(intercepted, true, 'the failed barrier followed actual accepted bytes');
      const events = await listTaskEvents(workspaceDir);
      assert.equal(
        events.some((event) => event.type === 'acceptance_pass'),
        false
      );
      assert.equal(events.at(-1).phase, 'failed');
      const artifacts = await loadTaskArtifacts(workspaceDir);
      assert.equal(
        artifacts.tasks.some((task) => task.status === 'accepted'),
        false
      );
      if (target === 'acceptance.jsonl')
        assert.equal(
          artifacts.acceptance.some((verdict) => verdict.verdict === 'pass'),
          false
        );
      // A failed settlement is resumable, and recovery must consult a fresh
      // authority rather than short-circuiting on an earlier partial append.
      const resumed = await resumeTask(
        {
          workspaceDir,
          maxRepairAttempts: 0,
          runTurn: async () => 'fresh turn',
          verdictProvider: {
            source: 'contract',
            evaluate: async (taskId) => ({
              taskId,
              passed: false,
              source: 'contract',
              detail: 'fresh authority rejects recovery',
            }),
          },
        },
        events[0].taskId
      );
      assert.equal(resumed.outcome, 'fail');
      assert.notEqual(resumed.snapshot.phase, 'accepted');
    } finally {
      fs.open = originalOpen;
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
}

test('contract PASS waits for a real file durability barrier', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-sync-barrier-'));
  const originalOpen = fs.open;
  let synced = false;
  try {
    await appendTaskRecord(workspaceDir, {
      taskId: 'one',
      goal: 'one',
      status: 'active',
      acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await appendEvidenceRecord(workspaceDir, {
      evidenceId: 'one',
      taskId: 'one',
      metric: 'probe',
      observed: 1,
      result: 'pass',
      source: 'exec',
      timestamp: Date.now(),
    });
    fs.open = async function (file, flags, ...args) {
      const handle = await originalOpen.call(this, file, flags, ...args);
      if (String(file).endsWith('acceptance.jsonl') && flags === 'r+') {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          synced = true;
        };
      }
      return handle;
    };
    assert.equal((await createContractVerdictProvider(workspaceDir).evaluate('one')).passed, true);
    assert.equal(synced, true, 'a successful public PASS followed an actual fsync');
  } finally {
    fs.open = originalOpen;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

for (const target of ['tasks.jsonl', 'task-events.jsonl']) {
  test(`a failed ${target} sync and rollback remain unaccepted in a fresh process`, async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-sync-rollback-'));
    const originalOpen = fs.open;
    let injected = false;
    try {
      fs.open = async function (file, flags, ...args) {
        const handle = await originalOpen.call(this, file, flags, ...args);
        if (String(file) === path.join(workspaceDir, '.moss', target) && flags === 'r+') {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            const visible = await fs.readFile(file, 'utf8');
            if (
              visible.includes(
                target === 'tasks.jsonl' ? '"status":"accepted"' : '"type":"acceptance_pass"'
              )
            ) {
              injected = true;
              throw Object.assign(new Error('permanent acceptance sync failure'), { code: 'EIO' });
            }
            return sync();
          };
          handle.truncate = async () => {
            throw Object.assign(new Error('permanent rollback failure'), { code: 'EIO' });
          };
        }
        return handle;
      };
      await assert.rejects(
        runTask(
          {
            workspaceDir,
            runTurn: async () => {
              const taskId = (await listTaskEvents(workspaceDir))[0].taskId;
              await appendTaskRecord(workspaceDir, {
                taskId,
                goal: 'one',
                status: 'active',
                acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              await appendEvidenceRecord(workspaceDir, {
                evidenceId: 'one',
                taskId,
                metric: 'probe',
                observed: 1,
                result: 'pass',
                source: 'exec',
                timestamp: Date.now(),
              });
              return 'one';
            },
          },
          'one'
        ),
        /permanent acceptance sync failure/
      );
      assert.equal(injected, true);
      assert.match(
        await fs.readFile(path.join(workspaceDir, '.moss', target), 'utf8'),
        /"(?:status|phase)":"accepted"/,
        'the real failed rollback leaves process-visible accepted bytes'
      );
      assert.ok(await fs.stat(path.join(workspaceDir, '.moss', `${target}.pending`)));
      fs.open = originalOpen;
      const probe = path.join(workspaceDir, 'fresh-reader.mjs');
      await fs.writeFile(
        probe,
        `import {loadTaskArtifacts,listTaskEvents,resumeTask} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
        const workspaceDir=${JSON.stringify(workspaceDir)};
        const artifacts=await loadTaskArtifacts(workspaceDir);const events=await listTaskEvents(workspaceDir);
        let recovered;try{recovered=await resumeTask({workspaceDir,runTurn:async()=> 'turn',maxRepairAttempts:0},events[0].taskId);}catch(error){recovered={error:error.message};}
        console.log(JSON.stringify({accepted:artifacts.tasks.some(t=>t.status==='accepted'),phase:events.at(-1).phase,
          recoveryPass:recovered.outcome==='pass',recoveryError:recovered.error}));`
      );
      const fresh = await runProcess(process.execPath, { args: [probe], timeout: 5000 });
      assert.equal(fresh.exitCode, 0, fresh.stderr);
      const state = JSON.parse(fresh.stdout.trim());
      assert.equal(state.accepted, false);
      assert.notEqual(state.phase, 'accepted');
      assert.equal(state.recoveryPass, false);
      assert.match(
        state.recoveryError,
        /unconfirmed task append requires recovery/,
        'the fresh process must report unresolved storage instead of fabricating recovery'
      );
    } finally {
      fs.open = originalOpen;
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
}

test('an unreadable or malformed prepare marker fails closed', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-prepare-invalid-'));
  const originalRead = fs.readFile;
  try {
    await appendTaskRecord(workspaceDir, {
      taskId: 'one',
      goal: 'one',
      status: 'active',
      acceptanceCriteria: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const marker = path.join(workspaceDir, '.moss', 'tasks.jsonl.pending');
    await fs.writeFile(marker, '{"originalSize":"unknown"}');
    await assert.rejects(loadTaskArtifacts(workspaceDir), /unconfirmed task append/);
    await fs.writeFile(marker, JSON.stringify({ originalSize: Number.MAX_SAFE_INTEGER }));
    await assert.rejects(loadTaskArtifacts(workspaceDir), /unconfirmed task append/);
    await fs.writeFile(marker, '{');
    await assert.rejects(loadTaskArtifacts(workspaceDir), SyntaxError);
    fs.readFile = async function (file, ...args) {
      if (String(file) === marker)
        throw Object.assign(new Error('prepare read denied'), { code: 'EACCES' });
      return originalRead.call(this, file, ...args);
    };
    await assert.rejects(loadTaskArtifacts(workspaceDir), { code: 'EACCES' });
  } finally {
    fs.readFile = originalRead;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

for (const barrier of ['prepare-sync', 'prepare-unlink']) {
  test(`${barrier} failure cannot publish a native PASS`, async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-prepare-fault-'));
    const originalOpen = fs.open;
    const originalUnlink = fs.unlink;
    let injected = false;
    try {
      await appendTaskRecord(workspaceDir, {
        taskId: 'one',
        goal: 'one',
        status: 'active',
        acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await appendEvidenceRecord(workspaceDir, {
        evidenceId: 'one',
        taskId: 'one',
        metric: 'probe',
        observed: 1,
        result: 'pass',
        source: 'exec',
        timestamp: Date.now(),
      });
      const marker = path.join(workspaceDir, '.moss', 'acceptance.jsonl.pending');
      fs.open = async function (file, flags, ...args) {
        const handle = await originalOpen.call(this, file, flags, ...args);
        if (barrier === 'prepare-sync' && String(file) === marker && flags === 'wx') {
          handle.sync = async () => {
            injected = true;
            throw Object.assign(new Error('prepare barrier failed'), { code: 'EIO' });
          };
        }
        return handle;
      };
      fs.unlink = async function (file, ...args) {
        if (barrier === 'prepare-unlink' && !injected && String(file) === marker) {
          injected = true;
          throw Object.assign(new Error('prepare barrier failed'), { code: 'EIO' });
        }
        return originalUnlink.call(this, file, ...args);
      };
      await assert.rejects(
        createContractVerdictProvider(workspaceDir).evaluate('one'),
        /prepare barrier failed/
      );
      assert.equal(injected, true);
      const artifacts = await loadTaskArtifacts(workspaceDir);
      assert.equal(artifacts.tasks[0].status, 'active');
      assert.equal(artifacts.acceptance.length, 0);
    } finally {
      fs.open = originalOpen;
      fs.unlink = originalUnlink;
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
}

test('every platform syncs acceptance files; POSIX directory sync failure rejects settlement', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-directory-sync-'));
  const originalOpen = fs.open;
  let fileSynced = false;
  let directoryFailed = false;
  try {
    await appendTaskRecord(workspaceDir, {
      taskId: 'one',
      goal: 'one',
      status: 'active',
      acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await appendEvidenceRecord(workspaceDir, {
      evidenceId: 'one',
      taskId: 'one',
      metric: 'probe',
      observed: 1,
      result: 'pass',
      source: 'exec',
      timestamp: Date.now(),
    });
    const acceptanceFile = path.join(workspaceDir, '.moss', 'acceptance.jsonl');
    fs.open = async function (file, flags, ...args) {
      const handle = await originalOpen.call(this, file, flags, ...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (String(file) === acceptanceFile && flags === 'r+') fileSynced = true;
        if (
          process.platform !== 'win32' &&
          !directoryFailed &&
          String(file) === path.dirname(acceptanceFile) &&
          flags === 'r' &&
          (await fs.readFile(acceptanceFile, 'utf8').catch(() => '')).includes('"verdict":"pass"')
        ) {
          directoryFailed = true;
          throw Object.assign(new Error('acceptance directory sync failed'), { code: 'EIO' });
        }
        return sync();
      };
      return handle;
    };
    if (process.platform === 'win32') {
      assert.equal(
        (await createContractVerdictProvider(workspaceDir).evaluate('one')).passed,
        true
      );
      assert.equal(directoryFailed, false, 'Node Windows has no directory fsync capability');
    } else {
      await assert.rejects(
        createContractVerdictProvider(workspaceDir).evaluate('one'),
        /acceptance directory sync failed/
      );
      assert.equal(directoryFailed, true);
      const artifacts = await loadTaskArtifacts(workspaceDir);
      assert.equal(artifacts.tasks[0].status, 'active');
      assert.equal(artifacts.acceptance.length, 0);
    }
    assert.equal(fileSynced, true, 'the real acceptance file always reaches its fsync barrier');
  } finally {
    fs.open = originalOpen;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
