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
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log(`[subagent-resume] PASS (${checks} checks)`);
