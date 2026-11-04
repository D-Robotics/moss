#!/usr/bin/env node
/**
 * Turn watch (external edit + date rollover notice), ported from Qoder
 * conversation mining 2026-11-04: `edited_text_file` (213 occurrences) and
 * `date_change` (24) were the two runtime injections Moss lacked. Locks:
 * (1) files touched by tool calls and modified after the session's last
 * activity are reported once per mtime; (2) files rewritten before the last
 * activity (the agent's own build) stay silent; (3) a calendar rollover
 * emits exactly one line; (4) missing timestamps, single-message sessions
 * and MOSS_DISABLE_TURN_WATCH=1 never emit; (5) a previously reported file
 * that vanished is named as deleted.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildTurnWatchNotice,
  collectTouchedWorkspaceFiles,
  sessionLastActivityMs,
} from '../dist/context/turn-watch.js';

const HOUR = 3_600_000;
const base = Date.now() - HOUR;

function readConversation(workspaceDir, file, ts) {
  return [
    { role: 'user', content: 'go', timestamp: ts - 5000 },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { file_path: file } }],
      timestamp: ts - 4000,
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'old body' }],
      timestamp: ts,
    },
  ];
}

test('collectTouchedWorkspaceFiles tracks ws keys, skips device and outside paths', () => {
  const ws = '/tmp/proj';
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'read', input: { file_path: 'src/a.ts' } },
        { type: 'tool_use', id: 'b', name: 'edit', input: { file_path: '/tmp/proj/lib/b.ts' } },
        { type: 'tool_use', id: 'c', name: 'device_file_read', input: { path: '/etc/x' } },
        { type: 'tool_use', id: 'd', name: 'exec', input: { command: 'echo hi > out.txt' } },
        { type: 'tool_use', id: 'e', name: 'read', input: { file_path: '../outside.ts' } },
      ],
      timestamp: base,
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'x' },
        { type: 'tool_result', tool_use_id: 'b', content: 'x' },
        { type: 'tool_result', tool_use_id: 'c', content: 'x' },
        { type: 'tool_result', tool_use_id: 'd', content: 'x' },
        { type: 'tool_result', tool_use_id: 'e', content: 'x' },
      ],
      timestamp: base + 1000,
    },
  ];
  const tracked = collectTouchedWorkspaceFiles(messages, ws);
  const rels = [...tracked.values()].map((f) => f.relativePath).sort();
  assert.deepEqual(rels, ['lib/b.ts', 'out.txt', 'src/a.ts']);
  for (const f of tracked.values()) {
    assert.equal(f.lastTouchMs, base + 1000, 'tool_result message timestamp is the touch time');
  }
});

test('externally edited file is reported once per mtime, with head snippet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turn-watch-'));
  try {
    const file = path.join(dir, 'notes.md');
    await writeFile(file, 'shopping list: milk\neggs');
    const ts = base;
    const messages = readConversation(dir, file, ts);
    // External edit: the user rewrites the file while holding the turn.
    const editTime = ts + 5 * 60_000;
    await utimes(file, new Date(editTime), new Date(editTime));

    const first = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: new Map(),
      lastSeenDate: undefined,
      now: ts + 10 * 60_000,
    });
    assert.ok(first.notice, 'external edit must produce a notice');
    assert.match(first.notice, /notes\.md/);
    assert.match(first.notice, /starts with: `shopping list/);
    assert.equal(first.reportedMtimes.get(file), (await statMtime(file)).mtimeMs);

    const second = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: first.reportedMtimes,
      lastSeenDate: first.todayDate,
      now: ts + 11 * 60_000,
    });
    assert.equal(second.notice, null, 'same mtime must not be reported twice');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file rewritten before the session last went idle stays silent (own build)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turn-watch-'));
  try {
    const file = path.join(dir, 'dist.js');
    await writeFile(file, 'compiled');
    const lastActivity = base + 60_000;
    await utimes(file, new Date(lastActivity - 1000), new Date(lastActivity - 1000));
    const messages = readConversation(dir, file, base);
    messages.push({ role: 'assistant', content: 'done', timestamp: lastActivity });

    const r = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: new Map(),
      now: lastActivity + 60_000,
    });
    assert.equal(r.notice, null, 'mtime older than the last message is not an external edit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('calendar rollover emits exactly one line and updates todayDate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turn-watch-'));
  try {
    const messages = [
      { role: 'user', content: 'hi', timestamp: base },
      { role: 'assistant', content: 'hello', timestamp: base + 1000 },
    ];
    const now = Date.now();
    const yesterday = new Date(now - 24 * HOUR);
    const yDate = `${yesterday.getFullYear()}-${`${yesterday.getMonth() + 1}`.padStart(2, '0')}-${`${yesterday.getDate()}`.padStart(2, '0')}`;
    const r = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: new Map(),
      lastSeenDate: yDate,
      now,
    });
    assert.ok(r.notice);
    assert.match(r.notice, /Calendar date changed/);
    assert.ok(r.notice.includes(r.todayDate));
    assert.ok(r.notice.includes(yDate), 'the previous date is named so the delta is unambiguous');

    const again = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: r.reportedMtimes,
      lastSeenDate: r.todayDate,
      now,
    });
    assert.equal(again.notice, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no timestamps or single-message sessions emit nothing', async () => {
  const r1 = await buildTurnWatchNotice({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
    workspaceDir: '/tmp',
    reportedMtimes: new Map(),
    lastSeenDate: '2000-01-01',
    now: Date.now(),
  });
  assert.ok(
    !r1.notice?.includes('Files changed'),
    'legacy messages without timestamps skip edit detection'
  );
  assert.ok(r1.todayDate, 'todayDate still maintained for the date rollover');

  const r2 = await buildTurnWatchNotice({
    messages: [{ role: 'user', content: 'fresh', timestamp: Date.now() }],
    workspaceDir: '/tmp',
    reportedMtimes: new Map(),
  });
  assert.equal(r2.notice, null, 'a brand-new session has nothing to watch yet');
});

test('MOSS_DISABLE_TURN_WATCH=1 disables the watch', async () => {
  const prev = process.env.MOSS_DISABLE_TURN_WATCH;
  process.env.MOSS_DISABLE_TURN_WATCH = '1';
  try {
    const r = await buildTurnWatchNotice({
      messages: [
        { role: 'user', content: 'a', timestamp: base },
        { role: 'assistant', content: 'b', timestamp: base },
      ],
      workspaceDir: '/tmp',
      reportedMtimes: new Map(),
      lastSeenDate: '2000-01-01',
      now: Date.now(),
    });
    assert.equal(r.notice, null);
    assert.equal(r.reportedMtimes.size, 0);
  } finally {
    if (prev === undefined) delete process.env.MOSS_DISABLE_TURN_WATCH;
    else process.env.MOSS_DISABLE_TURN_WATCH = prev;
  }
});

test('previously reported file that vanished is named as deleted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turn-watch-'));
  try {
    const file = path.join(dir, 'gone.ts');
    await writeFile(file, 'x');
    const mtime = Date.now() - HOUR;
    await utimes(file, new Date(mtime), new Date(mtime));
    const messages = readConversation(dir, file, mtime);
    const first = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: new Map(),
      now: Date.now(),
    });
    assert.ok(first.reportedMtimes.has(file), 'baseline stat recorded');
    await rm(file, { force: true });

    const second = await buildTurnWatchNotice({
      messages,
      workspaceDir: dir,
      reportedMtimes: first.reportedMtimes,
      lastSeenDate: first.todayDate,
      now: Date.now(),
    });
    assert.ok(second.notice, 'deletion must be surfaced');
    assert.match(second.notice, /gone\.ts \(deleted since it was last seen\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sessionLastActivityMs takes the newest timestamp', () => {
  assert.equal(sessionLastActivityMs([{ role: 'user', content: 'a', timestamp: 5 }]), 5);
  assert.equal(sessionLastActivityMs([{ role: 'user', content: 'a' }]), null);
});

async function statMtime(file) {
  const { stat } = await import('node:fs/promises');
  return stat(file);
}
