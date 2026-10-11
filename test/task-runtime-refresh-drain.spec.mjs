/** Public runtime joins real native IO; storage failures never become success. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { TaskRuntime, acquireSessionWriteLock } from '../dist/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observed(promise) {
  const record = { state: 'pending', error: undefined };
  record.settled = promise.then(
    () => {
      record.state = 'fulfilled';
    },
    (error) => {
      record.state = 'rejected';
      record.error = error;
    }
  );
  return record;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function entered(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`native ${label} barrier was not reached`)),
          4000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixtureRoot() {
  const parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'moss-refresh-drain-probe-'));
  assert.equal(path.dirname(path.resolve(root)), parent);
  assert.ok(path.basename(root).startsWith('moss-refresh-drain-probe-'));
  return root;
}
async function assertAbsent(file) {
  await assert.rejects(fs.access(file), (error) => error.code === 'ENOENT');
}

for (const failQueuedRead of [false, true]) {
  test(
    `refresh and same-run endRun join actual first and queued IO (${failQueuedRead ? 'EIO' : 'success'})`,
    { timeout: 5000 },
    async () => {
      const root = await fixtureRoot();
      const recovery = path.join(root, '.moss', 'task-events.jsonl.lock.recovery');
      const canonical = path.join(root, '.moss', 'task-events.jsonl.lock');
      const firstEntered = deferred();
      const firstAllowed = deferred();
      const queuedEntered = deferred();
      const queuedAllowed = deferred();
      const originalRead = fs.readFile;
      const queuedError = Object.assign(new Error('real queued recovery read EIO'), {
        code: 'EIO',
      });
      const records = [];
      let recoveryReads = 0;
      let cleanupStarted = false;
      let watchdog;
      try {
        fs.readFile = async function (file, ...args) {
          const bytes = await originalRead.call(this, file, ...args);
          if (String(file) === recovery) {
            recoveryReads++;
            const owner = JSON.parse(String(bytes));
            assert.equal(owner.pid, process.pid, 'native recovery owner is really published');
            assert.ok(owner.token.length >= 16);
            if (recoveryReads === 1) {
              firstEntered.resolve();
              await firstAllowed.promise;
            } else if (recoveryReads === 3) {
              // Empty runtime pass: loadTaskArtifacts and listTaskRecords take the
              // first two locks. This is the queued pass's actual recovery gate.
              queuedEntered.resolve();
              await queuedAllowed.promise;
              if (failQueuedRead) throw queuedError;
            }
          }
          return bytes;
        };
        syncBuiltinESMExports();
        watchdog = setTimeout(() => {
          firstAllowed.resolve();
          queuedAllowed.resolve();
        }, 4500);
        const runtime = new TaskRuntime({ workspaceDir: root });
        runtime.beginRun();
        const first = observed(runtime.refresh());
        records.push(first);
        await entered(firstEntered.promise, 'first');
        const second = observed(runtime.refresh());
        const end = observed(runtime.endRun(false));
        records.push(second, end);
        await tick();
        const firstBarrier = { first: first.state, second: second.state, end: end.state };
        assert.equal(cleanupStarted, false);
        assert.equal(runtime.getLiveState().running, false, 'UI flag alone is not the IO drain');
        firstAllowed.resolve();
        await entered(queuedEntered.promise, 'queued');
        await tick();
        const queuedBarrier = { first: first.state, second: second.state, end: end.state };
        queuedAllowed.resolve();
        await Promise.all(records.map((record) => record.settled));
        console.log(
          JSON.stringify({
            failQueuedRead,
            recoveryReads,
            firstBarrier,
            queuedBarrier,
            final: records.map((record) => ({ state: record.state, error: record.error?.message })),
          })
        );
        assert.deepEqual(firstBarrier, { first: 'pending', second: 'pending', end: 'pending' });
        assert.deepEqual(queuedBarrier, { first: 'pending', second: 'pending', end: 'pending' });
        if (failQueuedRead) {
          // Unknown read fails closed; every joined caller must observe the same
          // actual failure. The recovery file is intentionally retained below.
          assert.ok(records.every((record) => record.state === 'rejected'));
          assert.ok(records.every((record) => record.error?.code === 'SESSION_PERSIST_FAILED'));
          assert.equal(second.error, first.error, 'joined callers preserve the original error');
          assert.equal(end.error, first.error, 'same-run endRun must not hide the original error');
          const owner = JSON.parse(await originalRead(recovery, 'utf8'));
          assert.equal(owner.pid, process.pid);
        } else {
          assert.ok(records.every((record) => record.state === 'fulfilled'));
          await assertAbsent(canonical);
          await assertAbsent(recovery);
        }
      } finally {
        clearTimeout(watchdog);
        firstAllowed.resolve();
        queuedAllowed.resolve();
        await Promise.all(records.map((record) => record.settled));
        fs.readFile = originalRead;
        syncBuiltinESMExports();
        cleanupStarted = true;
        // Only this function's validated, freshly created system-temp root.
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
}

for (const mutation of ['missing', 'successor']) {
  test(
    `owned release stays fail-closed for a real ${mutation} owner`,
    { timeout: 5000 },
    async () => {
      const root = await fixtureRoot();
      const sessionFile = path.join(root, 'real-session.jsonl');
      const lockPath = `${sessionFile}.lock`;
      try {
        const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 1000 });
        const original = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        assert.equal(original.pid, process.pid);
        let successorBytes;
        if (mutation === 'missing') {
          await fs.unlink(lockPath);
        } else {
          successorBytes = `${JSON.stringify({
            version: 1,
            pid: process.pid,
            token: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          })}\n`;
          const replacement = `${lockPath}.probe-successor`;
          const handle = await fs.open(replacement, 'wx', 0o600);
          try {
            await handle.writeFile(successorBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(replacement, lockPath);
        }
        await assert.rejects(
          lock.release(),
          (error) => error.code === 'SESSION_PERSIST_FAILED' && /owner/.test(error.message)
        );
        if (mutation === 'missing') await assertAbsent(lockPath);
        else
          assert.equal(
            await fs.readFile(lockPath, 'utf8'),
            successorBytes,
            'old release cannot remove or modify a real successor'
          );
        await assertAbsent(`${lockPath}.released-${original.token}`);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
}

test(
  'first IO failure is shared without a queued retry masking it',
  { timeout: 5000 },
  async () => {
    const root = await fixtureRoot();
    const recovery = path.join(root, '.moss', 'task-events.jsonl.lock.recovery');
    const firstEntered = deferred();
    const firstAllowed = deferred();
    const originalRead = fs.readFile;
    const records = [];
    let recoveryReads = 0;
    let watchdog;
    try {
      fs.readFile = async function (file, ...args) {
        const bytes = await originalRead.call(this, file, ...args);
        if (String(file) === recovery) {
          assert.equal(JSON.parse(String(bytes)).pid, process.pid);
          recoveryReads++;
          firstEntered.resolve();
          await firstAllowed.promise;
          throw Object.assign(new Error('first native recovery read EIO'), { code: 'EIO' });
        }
        return bytes;
      };
      syncBuiltinESMExports();
      watchdog = setTimeout(() => firstAllowed.resolve(), 4500);
      const runtime = new TaskRuntime({ workspaceDir: root });
      runtime.beginRun();
      const first = observed(runtime.refresh());
      records.push(first);
      await entered(firstEntered.promise, 'first-error');
      records.push(observed(runtime.refresh()), observed(runtime.endRun(false)));
      firstAllowed.resolve();
      await Promise.all(records.map((record) => record.settled));
      assert.ok(records.every((record) => record.state === 'rejected'));
      assert.equal(first.error?.code, 'SESSION_PERSIST_FAILED');
      assert.ok(records.every((record) => record.error === first.error));
      assert.equal(
        recoveryReads,
        2,
        'only the same acquire JSON and legacy owner reads occur; no queued acquisition starts'
      );
      assert.equal(JSON.parse(await originalRead(recovery, 'utf8')).pid, process.pid);
    } finally {
      clearTimeout(watchdog);
      firstAllowed.resolve();
      await Promise.all(records.map((record) => record.settled));
      fs.readFile = originalRead;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'background refresh failure is visible and remains authoritative at endRun',
  { timeout: 5000 },
  async () => {
    const root = await fixtureRoot();
    const recovery = path.join(root, '.moss', 'task-events.jsonl.lock.recovery');
    const originalRead = fs.readFile;
    const failed = deferred();
    const reads = [];
    let dispose;
    try {
      fs.readFile = async function (file, ...args) {
        const bytes = await originalRead.call(this, file, ...args);
        if (String(file) === recovery) {
          assert.equal(JSON.parse(String(bytes)).pid, process.pid);
          reads.push(String(bytes));
          throw Object.assign(new Error('background native recovery read EIO'), { code: 'EIO' });
        }
        return bytes;
      };
      syncBuiltinESMExports();
      const runtime = new TaskRuntime({ workspaceDir: root });
      runtime.beginRun();
      dispose = runtime.onChange(() => {
        if (runtime.getLiveState().lastError) failed.resolve();
      });
      runtime.applyEvent({
        type: 'tool_end',
        toolName: 'record_evidence',
        toolCallId: 'background-failure',
        result: 'recorded',
        isError: false,
      });
      await entered(failed.promise, 'visible background error');
      assert.match(runtime.getLiveState().lastError.message, /owner/);
      assert.equal(runtime.getLiveState().lastError.tool, 'record_evidence');
      const readsBeforeEndRun = reads.length;
      assert.equal(readsBeforeEndRun, 2, 'JSON and legacy fallback both fail on actual reads');
      await assert.rejects(
        runtime.endRun(false),
        (error) => error.code === 'SESSION_PERSIST_FAILED' && /owner/.test(error.message)
      );
      await tick(); // Node's real unhandled rejection reporting remains enabled.
      assert.equal(
        reads.length,
        readsBeforeEndRun,
        'endRun reports the original error, not another lock acquisition'
      );
      assert.equal(JSON.parse(await originalRead(recovery, 'utf8')).pid, process.pid);
    } finally {
      dispose?.();
      fs.readFile = originalRead;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'refresh requested by a notification joins and drains its own next IO round',
  { timeout: 5000 },
  async () => {
    const root = await fixtureRoot();
    const runtime = new TaskRuntime({ workspaceDir: root });
    let joined;
    const dispose = runtime.onChange(() => {
      if (runtime.version === 1) joined = runtime.refresh();
    });
    try {
      const first = runtime.refresh();
      await first;
      assert.equal(joined, first);
      assert.equal(
        runtime.version,
        2,
        'listener request cannot disappear at the completion boundary'
      );
      await assertAbsent(path.join(root, '.moss', 'task-events.jsonl.lock'));
      await assertAbsent(path.join(root, '.moss', 'task-events.jsonl.lock.recovery'));
    } finally {
      dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
