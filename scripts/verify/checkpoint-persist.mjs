#!/usr/bin/env node
/**
 * Long-run parity probe: checkpoints survive a session restart.
 *
 * Claude Code stores checkpoints with the conversation, so `/rewind` still
 * works after resuming a session (100 most recent per session). Moss kept the
 * list in memory only: the backup files were on disk, but a restarted session
 * listed zero checkpoints and the files were unrecoverable through the tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { FileCheckpointStore } = await import(
  pathToFileURL(path.join(root, 'dist/cli/file-checkpoint.js')).href
);

const runtimeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cp-')));
const sessionKey = 'session-checkpoint-persist';
const workspace = path.join(runtimeDir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const first = path.join(workspace, 'first.txt');
const second = path.join(workspace, 'second.txt');
fs.writeFileSync(first, 'before-first');
fs.writeFileSync(second, 'before-second');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[checkpoint-persist] ok ${name}`);
};

// 1. Two turns with writes, then a brand-new store instance (the restart).
{
  const store = new FileCheckpointStore({ runtimeDir, sessionKey });
  assert.deepEqual(store.list(), []);

  store.open('first prompt', 4);
  store.trackBeforeWrite(first);
  fs.writeFileSync(first, 'after-first');
  store.noteAfterWrite(first);

  store.open('second prompt', 9);
  store.trackBeforeWrite(second);
  fs.writeFileSync(second, 'after-second');
  store.noteAfterWrite(second);

  const restarted = new FileCheckpointStore({ runtimeDir, sessionKey });
  const list = restarted.list();
  assert.equal(list.length, 2, 'both checkpoints are visible after a restart');
  assert.deepEqual(
    list.map((cp) => [cp.seq, cp.label, cp.messageCount, cp.fileCount]),
    [
      [1, 'first prompt', 4, 1],
      [2, 'second prompt', 9, 1],
    ]
  );

  // 2. Rewinding from the restarted store restores real content.
  const result = restarted.rewindTo(1);
  assert.equal(result.found, true);
  assert.deepEqual(new Set(result.restored), new Set([first, second]));
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(first, 'utf8'), 'before-first');
  assert.equal(fs.readFileSync(second, 'utf8'), 'before-second');

  // The rewind is persisted too: a third instance sees the trimmed list.
  const afterRewind = new FileCheckpointStore({ runtimeDir, sessionKey });
  assert.deepEqual(afterRewind.list(), []);
  ok('checkpoints and files are restored from a fresh store instance');
}

// 3. Retention is 100 like Claude, and pruning deletes the backups of dropped
//    checkpoints instead of only forgetting them.
{
  const boundedDir = path.join(runtimeDir, 'bounded');
  fs.mkdirSync(boundedDir, { recursive: true });
  const target = path.join(boundedDir, 'target.txt');
  fs.writeFileSync(target, 'v0');
  const store = new FileCheckpointStore({ runtimeDir, sessionKey: 'bounded' });
  for (let i = 1; i <= 101; i += 1) {
    store.open(`turn ${i}`, i);
    store.trackBeforeWrite(target);
    fs.writeFileSync(target, `v${i}`);
    store.noteAfterWrite(target);
  }
  const list = store.list();
  assert.equal(list.length, 100, 'the newest 100 checkpoints are kept');
  assert.equal(list[0].seq, 2);
  assert.equal(list.at(-1).seq, 101);

  const storeDir = path.join(runtimeDir, 'checkpoints', encodeURIComponent('bounded'));
  const backups = fs
    .readdirSync(storeDir)
    .filter((name) => name !== 'checkpoints.json' && name !== 'checkpoints.json.tmp');
  assert.equal(backups.length, 100, 'dropped checkpoints no longer leave backups behind');
  ok('retention is 100 and pruning removes orphaned backups');
}

// 4. Corrupt metadata is not a boot failure, it is "no rewind points".
{
  const corruptDir = path.join(runtimeDir, 'corrupt');
  fs.mkdirSync(path.join(runtimeDir, 'checkpoints', encodeURIComponent('corrupt')), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(runtimeDir, 'checkpoints', encodeURIComponent('corrupt'), 'checkpoints.json'),
    '{not json'
  );
  const store = new FileCheckpointStore({ runtimeDir, sessionKey: 'corrupt' });
  assert.deepEqual(store.list(), []);
  assert.equal(store.rewindTo(1).found, false);
  assert.ok(!fs.existsSync(corruptDir));
  ok('corrupt metadata degrades to an empty list instead of throwing');
}

fs.rmSync(runtimeDir, { recursive: true, force: true });
console.log(`[checkpoint-persist] ${checks}/3 checks passed`);
