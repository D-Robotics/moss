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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-jsonl-test-'));
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

// ─── 1. repeated replaceMessages prunes dead lines ──────────────────────────
{
  const dir = await makeTempDir();
  const store = new JsonlSessionStore({ dir });
  const file = sessionFile(dir, 's1');

  await store.appendMessage('s1', userMsg('a'));
  await store.appendMessage('s1', userMsg('b'));
  await store.replaceMessages('s1', [userMsg('a'), userMsg('b'), userMsg('c')]);
  await store.appendMessage('s1', userMsg('d'));
  await store.replaceMessages(
    's1',
    [userMsg('a'), userMsg('b'), userMsg('c'), userMsg('d'), userMsg('e')],
  );

  const raw = await fs.readFile(file, 'utf-8');
  const stateReplaceLines = countStateReplaceLines(raw);
  assert.equal(
    stateReplaceLines,
    1,
    `expected exactly 1 state_replace line after 2 replaces, got ${stateReplaceLines}; dead lines must be pruned, not accumulated`,
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

console.log('  [PASS] jsonl-session-store: replaceMessages prunes dead lines, replay correct');
