#!/usr/bin/env node
/**
 * TUI utility functions — tested from the user's perspective:
 * what the user sees in the session list and shell tooling.
 * The footer/status-bar chrome tests were removed with the dead exports
 * (the ink TUI renders its own status bar); the queued-input model tests
 * were removed with the dead module (v0.14-S3).
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  formatTuiSessions,
  runLocalShellCommand,
  sanitizeRenderableText,
} from '../dist/cli/tui-utils.js';

// ─── formatTuiSessions ──────────────────────────────────────────────────────

{
  const rendered = formatTuiSessions([], 'current-key');
  assert.ok(rendered.includes('current-key'), 'shows current session key');
  assert.ok(rendered.includes('No saved sessions'), 'shows empty state message');
  assert.ok(rendered.includes('moss resume'), 'shows how to resume from shell');
}

{
  const sessions = [
    { sessionKey: 'abc123', messageCount: 5, updatedAt: Date.now() - 60000, title: 'Fix the bug' },
    { sessionKey: 'def456', messageCount: 12, updatedAt: Date.now() - 3600000 },
  ];
  const rendered = formatTuiSessions(sessions, 'abc123');
  assert.ok(rendered.includes('abc123'), 'lists the current session');
  assert.ok(rendered.includes('def456'), 'lists other sessions');
  assert.ok(rendered.includes('Fix the bug'), 'shows session title when available');
  assert.ok(rendered.includes('*'), 'marks the current session with *');
  assert.ok(rendered.includes('5 message'), 'shows message count');
}

{
  const many = Array.from({ length: 15 }, (_, i) => ({
    sessionKey: `s${i}`,
    messageCount: i,
    updatedAt: Date.now() - i * 1000,
  }));
  const rendered = formatTuiSessions(many, 's0', { limit: 10 });
  assert.ok(rendered.includes('of 15'), 'shows total count when list is truncated');
}

// ─── runLocalShellCommand abort kills background children ────────────────────

if (process.platform !== 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-local-shell-abort-'));
  const pidFile = path.join(dir, 'child.pid');
  const controller = new AbortController();
  const running = runLocalShellCommand({
    command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
    cwd: dir,
    signal: controller.signal,
  });
  for (let attempt = 0; attempt < 250 && !fs.existsSync(pidFile); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(pidFile), 'background child pid is recorded before abort');
  const childPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  controller.abort();
  await assert.rejects(running, /aborted/);
  let childAlive = true;
  for (let attempt = 0; attempt < 250 && childAlive; attempt++) {
    try {
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8');
        if (/^\d+ \(.+\) Z /.test(stat)) {
          childAlive = false;
          break;
        }
      }
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      childAlive = false;
    }
  }
  assert.equal(childAlive, false, 'aborting local shell kills its background child process');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── sanitizeRenderableText ──────────────────────────────────────────────────

{
  const ansiText = '\x1b[31mHello\x1b[0m World';
  const clean = sanitizeRenderableText(ansiText);
  // Should not crash; control codes should be handled
  assert.ok(typeof clean === 'string', 'returns a string');
}

// ─── buildResumeReplay — resume surfaces prior tool calls, not just prose ──

import { buildResumeReplay, resumedToolLines } from '../dist/cli/tui-utils.js';

{
  const messages = [
    { role: 'user', content: 'create hello.js exporting add' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll create the file then verify it." },
        {
          type: 'tool_use',
          name: 'write_file',
          input: { path: 'hello.js', content: 'function add(a,b){return a+b}' },
        },
        { type: 'tool_use', name: 'exec', input: { command: 'node verify.js' } },
      ],
    },
    { role: 'user', content: 'did it print 5?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Yes, it printed 5.' }] },
  ];

  const replay = buildResumeReplay(messages);
  const kinds = replay.items.map((i) => i.kind);
  assert.ok(kinds.includes('user'), 'replay includes user rows');
  assert.ok(kinds.includes('assistant'), 'replay includes assistant rows');
  assert.ok(kinds.includes('system'), 'replay includes system rows for tool calls');

  // The two tool_use blocks must surface as system rows, with the tool name and
  // a headline summary of the input (path for write_file, command for exec).
  const toolRows = replay.items.filter((i) => i.kind === 'system');
  assert.equal(toolRows.length, 2, 'one system row per tool_use block');
  assert.ok(
    toolRows.some((r) => r.text.includes('write_file') && r.text.includes('hello.js')),
    'write_file row shows tool name + path headline'
  );
  assert.ok(
    toolRows.some((r) => r.text.includes('exec') && r.text.includes('node verify.js')),
    'exec row shows tool name + command headline'
  );
  // Tool rows come AFTER the assistant prose, in order.
  const assistantIdx = replay.items.findIndex((i) => i.kind === 'assistant');
  assert.ok(
    assistantIdx >= 0 && toolRows.every((r) => replay.items.indexOf(r) > assistantIdx),
    'tool rows follow the assistant prose that issued them'
  );

  // resumedToolLines: empty for user / text-only turns.
  assert.deepEqual(resumedToolLines(messages[0]), [], 'user message yields no tool lines');
  assert.deepEqual(
    resumedToolLines(messages[3]),
    [],
    'text-only assistant turn yields no tool lines'
  );
}

{
  // Tool-only assistant turn (no prose) still surfaces the tool calls.
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } }],
    },
  ];
  const replay = buildResumeReplay(messages);
  assert.equal(replay.items.length, 1, 'tool-only turn yields one system row');
  assert.equal(replay.items[0].kind, 'system');
  assert.ok(replay.items[0].text.includes('read_file'), 'tool-only turn surfaces the tool name');
}

console.log('[PASS] TUI utility functions');
