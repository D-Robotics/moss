import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDraftTask, appendTaskEvent, listTaskEvents } from '../dist/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a reader cannot replay cached acceptance after its writer rolled it back', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-read-aba-'));
  const originalRead = fs.readFile;
  const originalOpen = fs.open;
  const before = deferred();
  const readAllowed = deferred();
  const rawCaptured = deferred();
  const rawAllowed = deferred();
  const appendVisible = deferred();
  const failWriter = deferred();
  let armed = false;
  let firstPending = true;
  let cachedAccepted = false;
  let reader;
  let writer;
  let timer;
  try {
    const task = await createDraftTask(workspace, 'real race');
    await appendTaskEvent(workspace, task.taskId, 'execution_started');
    await appendTaskEvent(workspace, task.taskId, 'verification_started');
    const file = path.join(workspace, '.moss', 'task-events.jsonl');
    fs.readFile = async function (target, ...args) {
      if (armed && firstPending && String(target) === `${file}.pending`) {
        firstPending = false;
        try {
          return await originalRead.call(this, target, ...args);
        } catch (error) {
          assert.equal(error.code, 'ENOENT');
          before.resolve();
          await readAllowed.promise;
          throw error;
        }
      }
      const raw = await originalRead.call(this, target, ...args);
      if (armed && String(target) === file && String(raw).includes('"type":"acceptance_pass"')) {
        cachedAccepted = true;
        rawCaptured.resolve();
        await rawAllowed.promise;
      }
      return raw;
    };
    fs.open = async function (target, flags, ...args) {
      const handle = await originalOpen.call(this, target, flags, ...args);
      if (String(target) === file && flags === 'r+') {
        const sync = handle.sync.bind(handle);
        let fail = true;
        handle.sync = async () => {
          if (fail && (await originalRead(file, 'utf8')).includes('"type":"acceptance_pass"')) {
            fail = false;
            appendVisible.resolve();
            await failWriter.promise;
            throw Object.assign(new Error('real writer sync failure'), { code: 'EIO' });
          }
          return sync();
        };
      }
      return handle;
    };
    armed = true;
    reader = listTaskEvents(workspace, task.taskId);
    await before.promise;
    writer = appendTaskEvent(workspace, task.taskId, 'acceptance_pass');
    const rejected = assert.rejects(writer, /real writer sync failure/);
    const visible = await Promise.race([
      appendVisible.promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 100);
      }),
    ]);
    clearTimeout(timer);
    readAllowed.resolve();
    if (visible) {
      await rawCaptured.promise;
      failWriter.resolve();
      await rejected;
      rawAllowed.resolve();
    } else {
      // With a read mutex the writer cannot publish while the reader is paused.
      rawAllowed.resolve();
      await reader;
      await appendVisible.promise;
      failWriter.resolve();
      await rejected;
    }
    const events = await reader;
    assert.equal(
      events.some((event) => event.type === 'acceptance_pass'),
      false,
      `cached accepted bytes were exposed: ${cachedAccepted}`
    );
    assert.equal((await listTaskEvents(workspace, task.taskId)).at(-1).phase, 'verifying');
  } finally {
    armed = false;
    clearTimeout(timer);
    readAllowed.resolve();
    rawAllowed.resolve();
    failWriter.resolve();
    await Promise.allSettled([reader, writer]);
    fs.readFile = originalRead;
    fs.open = originalOpen;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('a child callback inherited from a released owner must acquire the mutex again', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-read-late-'));
  const { withTaskEventLock } = await import('../dist/core/task/task-store.js');
  const startChild = deferred();
  const writerEntered = deferred();
  const releaseWriter = deferred();
  let child;
  let writer;
  let settled = false;
  try {
    const task = await createDraftTask(workspace, 'late read');
    await withTaskEventLock(workspace, async () => {
      child = startChild.promise.then(async () => {
        const events = await listTaskEvents(workspace, task.taskId);
        settled = true;
        return events;
      });
    });
    writer = withTaskEventLock(workspace, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;
    startChild.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, 'a released ALS owner must not bypass the live writer');
    releaseWriter.resolve();
    await writer;
    assert.equal((await child).at(-1).phase, 'draft');
  } finally {
    startChild.resolve();
    releaseWriter.resolve();
    await Promise.allSettled([child, writer]);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('nested workspace reads reuse only their own active parent lock', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-nested-a-'));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-nested-b-'));
  const { withTaskEventLock } = await import('../dist/core/task/task-store.js');
  try {
    const task = await createDraftTask(a, 'a');
    await createDraftTask(b, 'b');
    await withTaskEventLock(a, () =>
      withTaskEventLock(b, async () => {
        const events = await listTaskEvents(a, task.taskId);
        assert.equal(events.at(-1).phase, 'draft');
        await assert.rejects(
          withTaskEventLock(a, async () => {}),
          /not re-entrant/
        );
      })
    );
  } finally {
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  }
});

test('a failed aggregate snapshot retains its lock until all sibling reads finish', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-read-drain-'));
  const { loadTaskArtifacts } = await import('../dist/index.js');
  const originalRead = fs.readFile;
  const entered = deferred();
  const release = deferred();
  let reader;
  let writer;
  let armed = false;
  let failed = false;
  let wrote = false;
  try {
    const task = await createDraftTask(workspace, 'read siblings');
    await fs.writeFile(path.join(workspace, '.moss', 'tasks.jsonl.pending'), '{');
    fs.readFile = async function (file, ...args) {
      if (armed && String(file) === path.join(workspace, '.moss', 'evidence.jsonl')) {
        entered.resolve();
        await release.promise;
      }
      return originalRead.call(this, file, ...args);
    };
    armed = true;
    reader = loadTaskArtifacts(workspace).catch((error) => {
      failed = true;
      throw error;
    });
    const rejected = assert.rejects(reader, SyntaxError);
    await entered.promise;
    writer = appendTaskEvent(workspace, task.taskId, 'execution_started').then(() => {
      wrote = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      failed,
      false,
      'the first failed read cannot release still-running sibling ownership'
    );
    assert.equal(wrote, false, 'the real writer must wait for the aggregate read to drain');
    release.resolve();
    await rejected;
    await writer;
    assert.equal(wrote, true);
  } finally {
    armed = false;
    release.resolve();
    await Promise.allSettled([reader, writer]);
    fs.readFile = originalRead;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
