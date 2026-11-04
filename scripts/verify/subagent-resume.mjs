#!/usr/bin/env node
/**
 * Deterministic probe for sub-agent resume (backlog B11).
 *
 * A finished sub-agent used to leave only a summary: continuing meant re-running
 * the task with no memory. The transcript store keeps the child conversation and
 * `subagent_resume` replays it before the follow-up. This probe exercises both
 * halves without a model: the store contract, and the tool's hand-off to
 * `ctx.spawnSubagent` (what the parent would send).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);

const store = await load('core/subagent/subagent-transcript.js');
const { subagentResumeTool } = await load('tools/create-subagent.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[subagent-resume] ok ${name}`);
};

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moss-subagent-resume-'));
const messages = [
  { role: 'user', content: 'read token.txt and report the token', timestamp: 1 },
  { role: 'assistant', content: 'TOKEN=42', timestamp: 2 },
];
try {
  // ── 1. Round-trip: the stored conversation comes back unchanged ──────────

  const saved = store.saveSubagentTranscript({
    workspaceDir: dir,
    id: 'task-abc/sub-12345678',
    meta: { task: 'read token.txt', scope: 'explore', maxTurns: 20 },
    messages,
  });
  assert.match(saved, /^\.moss\/runtime\/subagents\//, 'transcript is a runtime artifact');
  const loaded = store.loadSubagentTranscript(dir, 'task-abc/sub-12345678');
  assert.deepEqual(loaded.messages, messages);
  assert.equal(loaded.meta.scope, 'explore');
  assert.equal(loaded.meta.maxTurns, 20);
  ok('a finished conversation is stored under .moss/runtime/subagents and reloads verbatim');

  // ── 2. Ids cannot escape the directory ─────────────────────────────────

  store.saveSubagentTranscript({
    workspaceDir: dir,
    id: '../../escape',
    meta: { task: 'escape', scope: 'explore' },
    messages,
  });
  const files = fs.readdirSync(path.join(dir, '.moss', 'runtime', 'subagents'));
  assert.equal(files.length, 2);
  assert.ok(files.every((name) => !name.includes('..') && !name.includes('/')));
  ok('a hostile id is sanitized into a plain file name');

  // ── 3. Missing transcript is reported, not faked ───────────────────────

  assert.equal(store.loadSubagentTranscript(dir, 'nope'), null);
  let spawned = 0;
  const ctx = {
    workspaceDir: dir,
    runId: 'parent-run',
    spawnSubagent: async () => {
      spawned += 1;
      return { runId: 'unused', summary: '', success: false };
    },
  };
  const missing = await subagentResumeTool.execute({ taskId: 'nope', prompt: 'hi' }, ctx);
  assert.match(missing, /^Error: no stored conversation/);
  assert.equal(spawned, 0, 'a resume without a transcript must not spawn a child');
  ok('resuming an unknown id errors out without spawning a sub-agent');

  // ── 4. Resume replays the stored transcript and appends the prompt ─────

  const captured = [];
  const resumeCtx = {
    workspaceDir: dir,
    runId: 'parent-run',
    spawnSubagent: async (params) => {
      captured.push(params);
      return {
        runId: 'parent-run/sub-87654321',
        summary: 'RESUMED: TOKEN=42, file unchanged since',
        success: true,
        turns: 2,
        toolResults: 1,
        messages: [
          ...(params.priorMessages ?? []),
          { role: 'user', content: params.task, timestamp: 3 },
          { role: 'assistant', content: 'RESUMED: TOKEN=42, file unchanged since', timestamp: 4 },
        ],
      };
    },
  };
  const out = await subagentResumeTool.execute(
    { taskId: 'task-abc/sub-12345678', prompt: 'any change to token.txt since?' },
    resumeCtx
  );
  assert.equal(captured.length, 1);
  const sent = captured[0];
  assert.equal(sent.task, 'any change to token.txt since?');
  assert.deepEqual(sent.priorMessages, messages, 'the child sees exactly what it saw before');
  assert.equal(sent.scope, 'explore', 'scope is inherited from the stored run');
  assert.equal(sent.maxTurns, 20);
  assert.match(out, /\[Sub-agent .+\] RESUMED/);
  assert.match(out, /replayed: 2 message\(s\)/);
  assert.match(out, /RESUMED: TOKEN=42/);
  ok('resume replays the transcript, appends the follow-up, and inherits scope/maxTurns');

  // ── 5. The follow-up is itself stored, so resume chains ────────────────

  const chained = store.loadSubagentTranscript(dir, 'parent-run/sub-87654321');
  assert.ok(chained, 'the resumed run must be addressable by its own runId');
  assert.match(chained.meta.task, /\[resume\] any change to token\.txt since\?/);
  assert.ok(
    chained.messages.some((message) => message.content === 'read token.txt and report the token'),
    'the chained transcript still contains the original conversation'
  );
  ok('a resumed run stores its own transcript, so resume can continue again');

  // ── 6. A fresh process finds conversations on disk: `latest` and omitted id ─

  await new Promise((resolve) => setTimeout(resolve, 10));
  store.saveSubagentTranscript({
    workspaceDir: dir,
    id: 'newest-1',
    meta: { task: 'newest stored task', scope: 'plan', maxTurns: 7 },
    messages: [{ role: 'user', content: 'newest task', timestamp: 5 }],
  });
  const latestCtx = (capture) => ({
    workspaceDir: dir,
    runId: 'parent-run',
    spawnSubagent: async (params) => {
      capture.push(params);
      return {
        runId: 'parent-run/sub-latest',
        summary: 'LATEST-OK',
        success: true,
        turns: 1,
        toolResults: 0,
        messages: [
          ...(params.priorMessages ?? []),
          { role: 'assistant', content: 'LATEST-OK', timestamp: 6 },
        ],
      };
    },
  });
  // Iteration 1 resumes `newest-1`; that resume stores its own transcript, which
  // becomes the newest for iteration 2 — exactly how chaining works on disk.
  for (const [label, id, expectedId] of [
    ['omitted', undefined, 'newest-1'],
    ['explicit latest', 'latest', 'parent-run/sub-latest'],
  ]) {
    const capture = [];
    const out = await subagentResumeTool.execute(
      { ...(id ? { taskId: id } : {}), prompt: 'continue' },
      latestCtx(capture)
    );
    assert.equal(capture.length, 1, `${label}: resume must spawn`);
    assert.equal(capture[0].scope, 'plan', `${label}: newest scope is inherited`);
    if (expectedId === 'newest-1') assert.equal(capture[0].priorMessages[0].content, 'newest task');
    assert.match(
      out,
      new RegExp(`replayed: \\d+ message\\(s\\) from ${expectedId.replace(/[/]/g, '\\/')}`)
    );
  }
  ok('without an id (or with "latest") a fresh process resumes the newest stored sub-agent');

  // ── 7. An unknown id names what is resumable ────────────────────────────

  const unknown = await subagentResumeTool.execute(
    { taskId: 'does-not-exist', prompt: 'hi' },
    latestCtx([])
  );
  assert.match(unknown, /^Error: no stored conversation for sub-agent does-not-exist/);
  assert.match(unknown, /Stored conversations in this workspace:/);
  assert.match(unknown, /newest-1 \(scope plan\)/);
  ok('an unknown id lists the conversations that can be resumed');

  // ── 8. A workspace with no transcripts says so, and spawns nothing ──────

  const emptyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moss-subagent-empty-'));
  try {
    const spawnedInEmpty = [];
    const outEmpty = await subagentResumeTool.execute(
      { prompt: 'hi' },
      {
        workspaceDir: emptyDir,
        runId: 'parent-run',
        spawnSubagent: async (params) => {
          spawnedInEmpty.push(params);
          return { runId: 'x', summary: '', success: false };
        },
      }
    );
    assert.match(outEmpty, /Error: no stored sub-agent conversation in this workspace/);
    assert.equal(spawnedInEmpty.length, 0);
  } finally {
    await fsp.rm(emptyDir, { recursive: true, force: true });
  }
  ok('an empty workspace reports no resumable conversation instead of spawning');

  // ── 9. A still-running background task is waited for, then resumed ──────

  const { InMemoryMossAsyncTaskRegistry } = await load('contracts/async-task.js');
  const registry = new InMemoryMossAsyncTaskRegistry();
  let releaseLive;
  const liveGate = new Promise((resolve) => {
    releaseLive = resolve;
  });
  const liveMessages = [
    { role: 'user', content: 'index this repo', timestamp: 11 },
    { role: 'assistant', content: 'INDEXED', timestamp: 12 },
  ];
  registry.start(
    { taskId: 'live-run/sub-11112222', kind: 'subagent', label: 'index', payload: {} },
    async () => {
      await liveGate;
      store.saveSubagentTranscript({
        workspaceDir: dir,
        id: 'live-run/sub-11112222',
        meta: { task: 'index this repo', scope: 'explore', maxTurns: 12 },
        messages: liveMessages,
      });
      return { success: true, summary: 'index built' };
    }
  );
  const liveCtx = (capture) => ({
    workspaceDir: dir,
    runId: 'parent-run',
    asyncTaskRegistry: registry,
    spawnSubagent: async (params) => {
      capture.push(params);
      return {
        runId: 'live-run/sub-33334444',
        summary: 'LIVE-RESUMED',
        success: true,
        turns: 1,
        toolResults: 0,
        messages: [
          ...(params.priorMessages ?? []),
          { role: 'assistant', content: 'LIVE-RESUMED', timestamp: 13 },
        ],
      };
    },
  });
  const noWaitCapture = [];
  const noWait = await subagentResumeTool.execute(
    { taskId: 'live-run/sub-11112222', prompt: 'what did you find?', waitForRunning: false },
    liveCtx(noWaitCapture)
  );
  assert.match(noWait, /still RUNNING/, 'a live task is named as running, not as missing');
  assert.equal(noWaitCapture.length, 0, 'waitForRunning:false must not block or spawn');

  const waitCapture = [];
  const pending = subagentResumeTool.execute(
    { taskId: 'live-run/sub-11112222', prompt: 'what did you find?' },
    liveCtx(waitCapture)
  );
  // Let the tool reach `registry.wait`, then let the background run finish.
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseLive();
  const waited = await pending;
  assert.equal(waitCapture.length, 1, 'after the task finishes the follow-up spawns');
  assert.deepEqual(
    waitCapture[0].priorMessages,
    liveMessages,
    'the resumed child sees the background run conversation'
  );
  assert.equal(waitCapture[0].scope, 'explore');
  assert.match(waited, /\[Sub-agent .+\] RESUMED/);
  ok('a running background task is waited for, then resumed with its stored conversation');

  // ── 10. A task that finished without a transcript says exactly that ──────

  registry.start(
    { taskId: 'no-transcript/sub-55556666', kind: 'subagent', label: 'quiet', payload: {} },
    async () => ({ success: true, summary: 'done but not stored' })
  );
  await registry.wait('no-transcript/sub-55556666');
  const noTranscript = await subagentResumeTool.execute(
    { taskId: 'no-transcript/sub-55556666', prompt: 'continue' },
    liveCtx([])
  );
  assert.match(noTranscript, /finished \(completed\) but stored no conversation/);
  ok('a terminal task without a transcript is reported instead of silently spawning');
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log(`[subagent-resume] PASS (${checks} checks)`);
