#!/usr/bin/env node
/**
 * JsonlSessionStore — append/replace persistence and dead-line pruning.
 *
 * Verifies:
 *  (1) `replaceMessages` rewrites the file to a SINGLE `state_replace` line
 *      instead of appending — so repeated replaces do not accumulate dead
 *      snapshot lines (the O(history × replaces) growth bug).
 *  (2) `appendMessage` after a `replaceMessages` still appends incrementally.
 *  (3) Replay (`loadMessages`) returns the correct live message list after a
 *      mix of appends and replaces.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  appendJsonlLineDurably,
  ensureDirectoryDurably,
  JsonlSessionStore,
  removeFileDurably,
  rewriteJsonlFileDurably,
} from '../dist/core/session/jsonl-session-store.js';
import { ErrorCode, MossError } from '../dist/errors.js';

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-jsonl-test-'));
}

// ─── 0c. first append fsyncs its new directory entry ──────────────────────
if (process.platform !== 'win32') {
  const calls = [];
  const operations = {
    exists: async () => false,
    open: async (_filePath, flags) => {
      const isDirectory = flags === 'r';
      calls.push(`open:${isDirectory ? 'directory' : 'file'}`);
      return {
        writeFile: async () => {},
        appendFile: async () => calls.push('append'),
        sync: async () => {
          calls.push(isDirectory ? 'sync:directory' : 'sync:file');
          if (isDirectory) throw new Error('append directory fsync failed');
        },
        close: async () => calls.push(isDirectory ? 'close:directory' : 'close:file'),
      };
    },
  };
  await assert.rejects(
    () => appendJsonlLineDurably('/tmp/new-session.jsonl', '{}\n', operations),
    /append directory fsync failed/
  );
  assert.deepEqual(calls, [
    'open:file',
    'append',
    'sync:file',
    'close:file',
    'open:directory',
    'sync:directory',
    'close:directory',
  ]);

  calls.length = 0;
  await appendJsonlLineDurably('/tmp/existing-session.jsonl', '{}\n', {
    ...operations,
    exists: async () => true,
    open: async (_filePath, flags) => {
      assert.equal(flags, 'a', 'existing appends never reopen the parent directory');
      calls.push('open:file');
      return {
        writeFile: async () => {},
        appendFile: async () => calls.push('append'),
        sync: async () => calls.push('sync:file'),
        close: async () => calls.push('close:file'),
      };
    },
  });
  assert.deepEqual(calls, ['open:file', 'append', 'sync:file', 'close:file']);
}

// ─── 0d. fresh nested session directories persist every new parent entry ──
if (process.platform !== 'win32') {
  const calls = [];
  const operations = {
    exists: async (directoryPath) => {
      calls.push(`exists:${directoryPath}`);
      return directoryPath === '/existing';
    },
    mkdir: async (directoryPath) => calls.push(`mkdir:${directoryPath}`),
    open: async (directoryPath, flags) => {
      assert.equal(flags, 'r');
      calls.push(`open:${directoryPath}`);
      return {
        sync: async () => calls.push(`sync:${directoryPath}`),
        close: async () => calls.push(`close:${directoryPath}`),
      };
    },
  };
  await ensureDirectoryDurably('/existing/sessions/nested', operations);
  assert.deepEqual(calls, [
    'exists:/existing/sessions/nested',
    'exists:/existing/sessions',
    'exists:/existing',
    'mkdir:/existing/sessions',
    'open:/existing/sessions',
    'sync:/existing/sessions',
    'close:/existing/sessions',
    'open:/existing',
    'sync:/existing',
    'close:/existing',
    'mkdir:/existing/sessions/nested',
    'open:/existing/sessions/nested',
    'sync:/existing/sessions/nested',
    'close:/existing/sessions/nested',
    'open:/existing/sessions',
    'sync:/existing/sessions',
    'close:/existing/sessions',
  ]);
}

// ─── 0e. deletion fsyncs its parent and surfaces persistence failure ──────
if (process.platform !== 'win32') {
  const calls = [];
  await assert.rejects(
    () =>
      removeFileDurably('/sessions/deleted.jsonl', {
        unlink: async (filePath) => calls.push(`unlink:${filePath}`),
        open: async (directoryPath, flags) => {
          assert.equal(flags, 'r');
          calls.push(`open:${directoryPath}`);
          return {
            sync: async () => {
              calls.push(`sync:${directoryPath}`);
              throw new Error('delete directory fsync failed');
            },
            close: async () => calls.push(`close:${directoryPath}`),
          };
        },
      }),
    /delete directory fsync failed/
  );
  assert.deepEqual(calls, [
    'unlink:/sessions/deleted.jsonl',
    'open:/sessions',
    'sync:/sessions',
    'close:/sessions',
  ]);

  calls.length = 0;
  assert.equal(
    await removeFileDurably('/sessions/missing.jsonl', {
      unlink: async () => {
        calls.push('unlink');
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      open: async () => {
        calls.push('unexpected-open');
        throw new Error('must not open');
      },
    }),
    false
  );
  assert.deepEqual(calls, ['unlink']);
}

function userMsg(text) {
  return { role: 'user', content: text };
}

function countStateReplaceLines(raw) {
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.type === 'state_replace') n++;
    } catch {
      // ignore malformed
    }
  }
  return n;
}

function sessionFile(dir, sessionKey) {
  return path.join(dir, `${encodeURIComponent(sessionKey)}.jsonl`);
}

// ─── 0. every lock path bootstraps a fresh sessions directory ──────────────
{
  const root = await makeTempDir();
  for (const operation of ['append', 'append-capped', 'replace', 'load', 'delete']) {
    const dir = path.join(root, operation, 'sessions');
    const store = new JsonlSessionStore({
      dir,
      ...(operation === 'append-capped' && { maxSessions: 1 }),
    });
    if (operation === 'append') await store.appendMessage('fresh', userMsg('new'));
    if (operation === 'append-capped') await store.appendMessage('fresh', userMsg('new'));
    if (operation === 'replace') await store.replaceMessages('fresh', [userMsg('new')]);
    if (operation === 'load') assert.deepEqual(await store.loadMessages('fresh'), []);
    if (operation === 'delete') await store.deleteSession('fresh');
    assert.equal((await fs.stat(dir)).isDirectory(), true, `${operation} creates its lock parent`);
  }
  await fs.rm(root, { recursive: true, force: true });
}

// ─── 0b. rewrite fsyncs the renamed entry and surfaces directory failure ──
if (process.platform !== 'win32') {
  const calls = [];
  const operations = {
    open: async (filePath, flags) => {
      const isDirectory = flags === 'r';
      calls.push(`open:${isDirectory ? 'directory' : 'file'}`);
      return {
        writeFile: async () => calls.push('write'),
        sync: async () => {
          calls.push(isDirectory ? 'sync:directory' : 'sync:file');
          if (isDirectory) throw new Error('directory fsync failed');
        },
        close: async () => calls.push(isDirectory ? 'close:directory' : 'close:file'),
      };
    },
    rename: async () => calls.push('rename'),
    rm: async () => calls.push('cleanup'),
  };
  await assert.rejects(
    () => rewriteJsonlFileDurably('/tmp/session.jsonl', '{}\n', operations),
    /directory fsync failed/
  );
  assert.deepEqual(calls, [
    'open:file',
    'write',
    'sync:file',
    'close:file',
    'rename',
    'open:directory',
    'sync:directory',
    'close:directory',
    'cleanup',
  ]);
}

// ─── 1. repeated replaceMessages prunes dead lines ──────────────────────────
{
  const dir = await makeTempDir();
  const store = new JsonlSessionStore({ dir });
  const file = sessionFile(dir, 's1');

  await store.appendMessage('s1', userMsg('a'));
  await store.appendMessage('s1', userMsg('b'));
  await store.replaceMessages('s1', [userMsg('a'), userMsg('b'), userMsg('c')]);
  await store.appendMessage('s1', userMsg('d'));
  await store.replaceMessages('s1', [
    userMsg('a'),
    userMsg('b'),
    userMsg('c'),
    userMsg('d'),
    userMsg('e'),
  ]);

  const raw = await fs.readFile(file, 'utf-8');
  const stateReplaceLines = countStateReplaceLines(raw);
  assert.equal(
    stateReplaceLines,
    1,
    `expected exactly 1 state_replace line after 2 replaces, got ${stateReplaceLines}; dead lines must be pruned, not accumulated`
  );

  const loaded = await store.loadMessages('s1');
  assert.equal(loaded.length, 5, 'loadMessages returns the 5-message snapshot');
  assert.equal(loaded[4].content, 'e', 'last live message is the latest snapshot tail');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. appendMessage after replaceMessages is incremental ───────────────────
{
  const dir = await makeTempDir();
  const store = new JsonlSessionStore({ dir });
  const file = sessionFile(dir, 's2');

  await store.replaceMessages('s2', [userMsg('x'), userMsg('y')]);
  await store.appendMessage('s2', userMsg('z'));

  const raw = await fs.readFile(file, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2, 'file has 1 state_replace + 1 appended message line');

  const loaded = await store.loadMessages('s2');
  assert.equal(loaded.length, 3, 'snapshot(2) + appended(1) = 3 live messages');
  assert.equal(loaded[2].content, 'z');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 3. 20 growing replaces keep the file at a single snapshot ───────────────
{
  const dir = await makeTempDir();
  const store = new JsonlSessionStore({ dir });
  const file = sessionFile(dir, 's3');

  for (let i = 0; i < 20; i++) {
    const msgs = [];
    for (let j = 0; j <= i; j++) msgs.push(userMsg(`m${j}`));
    await store.replaceMessages('s3', msgs);
  }

  const raw = await fs.readFile(file, 'utf-8');
  assert.equal(countStateReplaceLines(raw), 1, '20 replaces → still 1 state_replace line');
  // Bounded size: the file should be roughly one snapshot (20 messages), not
  // the sum of all 20 growing snapshots (which would be ~210 messages of dead bytes).
  const loaded = await store.loadMessages('s3');
  assert.equal(loaded.length, 20, 'final snapshot has 20 live messages');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 4. corrupt trailing line preserves all complete history ────────────────
{
  const dir = await makeTempDir();
  const store = new JsonlSessionStore({ dir });
  const file = sessionFile(dir, 's4');
  await store.appendMessage('s4', userMsg('keep-1'));
  await store.appendMessage('s4', userMsg('keep-2'));
  await fs.appendFile(file, '{"type":"message","message":', 'utf-8');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const loaded = await store.loadMessages('s4');
    assert.deepEqual(
      loaded.map((message) => message.content),
      ['keep-1', 'keep-2']
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join('\n'), /skipped 1 malformed line/i);
  assert.match(warnings.join('\n'), /partially|incomplete|context gaps/i);

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 5. a stale replacement cannot erase another process' append ───────────
{
  const dir = await makeTempDir();
  const staleWriter = new JsonlSessionStore({ dir });
  const concurrentWriter = new JsonlSessionStore({ dir });

  await staleWriter.replaceMessages('shared', [userMsg('original')]);
  await staleWriter.loadMessages('shared');
  await concurrentWriter.loadMessages('shared');
  await concurrentWriter.appendMessage('shared', userMsg('concurrent'));
  await assert.rejects(
    () => staleWriter.appendMessage('shared', userMsg('stale-writer-tail')),
    (error) => error instanceof MossError && error.code === ErrorCode.SESSION_PERSIST_FAILED,
    'a stale turn must fail closed instead of interleaving after a competing turn'
  );
  assert.deepEqual(
    (await concurrentWriter.loadMessages('shared')).map((message) => message.content),
    ['original', 'concurrent']
  );

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 6. conflict detection also works across OS processes ──────────────────
{
  const dir = await makeTempDir();
  const parentStore = new JsonlSessionStore({ dir });
  await parentStore.replaceMessages('cross-process', [userMsg('parent')]);
  await parentStore.loadMessages('cross-process');

  const moduleUrl = new URL('../dist/core/session/jsonl-session-store.js', import.meta.url).href;
  const childScript = [
    `import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = new JsonlSessionStore({ dir: ${JSON.stringify(dir)} });`,
    `await store.loadMessages('cross-process');`,
    `await store.appendMessage('cross-process', { role: 'user', content: 'child' });`,
  ].join('\n');
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript]);

  await assert.rejects(
    () => parentStore.replaceMessages('cross-process', [userMsg('stale parent snapshot')]),
    (error) => error instanceof MossError && error.code === ErrorCode.SESSION_PERSIST_FAILED
  );
  assert.deepEqual(
    (await parentStore.loadMessages('cross-process')).map((message) => message.content),
    ['parent', 'child']
  );

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 9. a deleted session cannot be revived by a stale run ─────────────────
{
  const dir = await makeTempDir();
  const oldRun = new JsonlSessionStore({ dir });
  const owner = new JsonlSessionStore({ dir });
  await oldRun.appendMessage('deleted', userMsg('old history'));
  await oldRun.loadMessages('deleted');
  await owner.deleteSession('deleted');
  await assert.rejects(
    () => oldRun.appendMessage('deleted', { role: 'assistant', content: 'late answer' }),
    (error) => error instanceof MossError && error.code === ErrorCode.SESSION_PERSIST_FAILED
  );
  assert.equal(await owner.exists('deleted'), false);
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 10. public append remains valid after a process/store restart ─────────
{
  const dir = await makeTempDir();
  await new JsonlSessionStore({ dir }).appendMessage('restart', userMsg('before restart'));
  await new JsonlSessionStore({ dir }).appendMessage('restart', userMsg('after restart'));
  assert.deepEqual(
    (await new JsonlSessionStore({ dir }).loadMessages('restart')).map(
      (message) => message.content
    ),
    ['before restart', 'after restart']
  );
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 11. maxSessions pruning is atomic across store instances ────────────
{
  for (let attempt = 0; attempt < 10; attempt++) {
    const dir = await makeTempDir();
    const first = new JsonlSessionStore({ dir, maxSessions: 1 });
    const second = new JsonlSessionStore({ dir, maxSessions: 1 });
    await Promise.all([
      first.appendMessage('a', userMsg('first')),
      second.appendMessage('b', userMsg('second')),
    ]);
    const sessions = await first.listSessions();
    assert.equal(sessions.length, 1, 'concurrent pruning must retain exactly one complete session');
    assert.equal((await first.loadMessages(sessions[0].sessionKey)).length, 1);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── 12. maxSessions pruning is atomic across OS processes ───────────────
{
  const moduleUrl = new URL('../dist/core/session/jsonl-session-store.js', import.meta.url).href;
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = await makeTempDir();
    const childScript = [
      `import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};`,
      `const [dir, key] = process.argv.slice(1);`,
      `await new JsonlSessionStore({ dir, maxSessions: 1 }).appendMessage(key, { role: 'user', content: key });`,
    ].join('\n');
    await Promise.all([
      execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
        dir,
        'child-a',
      ]),
      execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
        dir,
        'child-b',
      ]),
    ]);
    const store = new JsonlSessionStore({ dir, maxSessions: 1 });
    const sessions = await store.listSessions();
    assert.equal(sessions.length, 1, 'cross-process pruning must retain exactly one session');
    assert.equal((await store.loadMessages(sessions[0].sessionKey)).length, 1);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── 7. a fresh writer must load before replacing a non-empty session ──────
{
  const dir = await makeTempDir();
  const owner = new JsonlSessionStore({ dir });
  await owner.appendMessage('blind-replace', userMsg('must survive'));
  const freshWriter = new JsonlSessionStore({ dir });
  await assert.rejects(
    () => freshWriter.replaceMessages('blind-replace', [userMsg('blind snapshot')]),
    (error) => error instanceof MossError && error.code === ErrorCode.SESSION_PERSIST_FAILED,
    'an unobserved non-empty file cannot be treated as an empty replace base'
  );
  assert.deepEqual(
    (await owner.loadMessages('blind-replace')).map((message) => message.content),
    ['must survive']
  );
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 8. deletion clears optimistic state before the key is reused ──────────
{
  const dir = await makeTempDir();
  const store = new JsonlSessionStore({ dir });
  await store.appendMessage('reused', userMsg('old'));
  await store.deleteSession('reused');
  await store.replaceMessages('reused', [userMsg('new')]);
  assert.deepEqual(
    (await store.loadMessages('reused')).map((message) => message.content),
    ['new']
  );
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('  [PASS] jsonl-session-store: replaceMessages prunes dead lines, replay correct');
