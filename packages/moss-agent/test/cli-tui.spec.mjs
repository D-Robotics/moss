#!/usr/bin/env node
/**
 * TUI utility functions — tested from the user's perspective:
 * what does the user see in the footer, status bar, session list, queue, etc.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  footerHint,
  statusLine,
  formatTuiSessions,
  formatQueueWait,
  queueItemMeta,
  shouldDrainQueue,
  stopRequestedMessage,
  queueResumedMessage,
  isQueueControlCommand,
  isImmediateGoalCommand,
  isLocalShellLine,
  sanitizeRenderableText,
  dropLastQueuedInput,
  renderSkills,
  promptCacheModeLabel,
  soulWelcomeHint,
} from '../dist/cli/tui.js';

// ─── footerHint ─────────────────────────────────────────────────────────────

{
  const hint = footerHint('ready');
  assert.ok(hint.includes('Tab complete'), 'ready state hints Tab for autocomplete');
  assert.ok(hint.includes('Up/Down history'), 'ready state hints history navigation');
  assert.ok(hint.includes('Ctrl+C exit'), 'ready state always shows how to exit');
  assert.ok(hint.includes('paste file path + Enter'), 'ready state mentions file attachment');
  assert.ok(hint.includes('Ctrl+O details'), 'ready state mentions Ctrl+O details');
}

{
  const hint = footerHint('running');
  assert.ok(hint.includes('Esc stop'), 'running state shows how to stop');
  assert.ok(hint.includes('Enter queue'), 'running state shows queueing');
}

{
  const hint = footerHint('approval');
  assert.ok(hint.includes('a'), 'approval state mentions approving');
  assert.ok(hint.toLowerCase().includes('trust scope') || hint.toLowerCase().includes('approve'), 'approval state guides user');
}

// macOS shows Ctrl+V attach; other platforms do not advertise it
if (process.platform === 'darwin') {
  assert.ok(footerHint('ready').includes('Ctrl+V attach'), 'macOS shows Ctrl+V file attachment hint');
} else {
  assert.ok(!footerHint('ready').includes('Ctrl+V attach'), 'non-macOS does not show Ctrl+V hint');
}

// ─── statusLine ─────────────────────────────────────────────────────────────

{
  const line = statusLine({ state: 'ready', model: 'deepseek-v4-pro', device: 'local', workspace: '/home/user/project' });
  assert.ok(line.includes('Moss'), 'status line always starts with Moss');
  assert.ok(line.includes('deepseek-v4-pro'), 'status line shows active model');
}

{
  const line = statusLine({ state: 'ready', model: '', device: 'board', workspace: '/tmp' });
  assert.ok(line.includes('no model'), 'status line flags missing model');
  assert.ok(line.includes('board'), 'status line shows device context');
}

// ─── promptCacheModeLabel ────────────────────────────────────────────────────

assert.equal(promptCacheModeLabel(), 'cache stable');
assert.equal(promptCacheModeLabel({ config: { promptCacheEnabled: false } }), 'cache off');
assert.equal(promptCacheModeLabel({ config: { promptCacheDebug: true } }), 'cache debug');

assert.ok(
  soulWelcomeHint({ id: 'moss-default', identity: 'default', source: 'default' }).includes('/soul'),
  'welcome hint makes the Soul entry discoverable',
);
assert.ok(
  soulWelcomeHint({ id: 'team', identity: 'custom', mode: 'prepend', source: 'workspace-file' })
    .includes('workspace persona'),
  'welcome hint identifies the active workspace persona',
);

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

// ─── formatQueueWait ────────────────────────────────────────────────────────

assert.equal(formatQueueWait(undefined), null, 'no enqueuedAt → null');
assert.equal(formatQueueWait(Date.now() - 500), '<1s', 'sub-second wait → <1s');
assert.equal(formatQueueWait(Date.now() - 30000), '30s', '30 second wait');
assert.equal(formatQueueWait(Date.now() - 90000), '1m', '90 second wait → 1m');
assert.equal(formatQueueWait(Date.now() - 3700000), '1h', 'hour-long wait → 1h');

// ─── queueItemMeta ──────────────────────────────────────────────────────────

{
  const item = { raw: 'hello world', message: 'hello world', enqueuedAt: Date.now() - 5000 };
  const meta = queueItemMeta(item);
  assert.ok(meta.includes('prompt'), 'plain text is labelled as a prompt');
  assert.ok(meta.includes('waiting'), 'shows wait time');
  assert.ok(meta.includes('1 line'), 'shows line count');
}

{
  const item = { raw: '/compact', message: '/compact', enqueuedAt: undefined };
  const meta = queueItemMeta(item);
  assert.ok(meta.includes('command'), 'slash message is labelled as a command');
}

{
  const item = { raw: '!ls -la', message: '!ls -la', enqueuedAt: undefined };
  const meta = queueItemMeta(item);
  assert.ok(meta.includes('local shell'), 'shell line is labelled as local shell');
}

// ─── shouldDrainQueue ───────────────────────────────────────────────────────

assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: false, queueLength: 1 }), true, 'drains when idle with items');
assert.equal(shouldDrainQueue({ busy: true, approvalActive: false, pausedAfterCancel: false, queueLength: 1 }), false, 'does not drain while busy');
assert.equal(shouldDrainQueue({ busy: false, approvalActive: true, pausedAfterCancel: false, queueLength: 1 }), false, 'does not drain during approval');
assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: true, queueLength: 1 }), false, 'does not drain when paused after cancel');
assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: false, queueLength: 0 }), false, 'does not drain with empty queue');

// ─── stopRequestedMessage / queueResumedMessage ──────────────────────────────

{
  const msg = stopRequestedMessage(0);
  assert.ok(msg.toLowerCase().includes('stop'), 'stop message mentions stopping');
}

{
  const msg = stopRequestedMessage(3);
  assert.ok(msg.includes('3 queued'), 'stop message shows queue length');
  assert.ok(msg.includes('/queue drop'), 'stop message shows how to discard queued prompts');
  // Regression: stop must NOT freeze the queue. The next queued prompt auto-drains,
  // so the message must not claim the queue is "paused" or offer "/queue resume".
  assert.ok(!msg.toLowerCase().includes('paus'), 'stop message does not say the queue is paused (it auto-drains)');
  assert.ok(!msg.includes('/queue resume'), 'stop message does not offer resume (queue is not paused)');
}

{
  const msg = queueResumedMessage(2);
  assert.ok(msg.includes('2 item'), 'resume message shows queue length');
}

assert.ok(queueResumedMessage(0).includes('resumed'), 'resume message confirms resumption');

// ─── isQueueControlCommand ──────────────────────────────────────────────────

assert.equal(isQueueControlCommand('/queue'), true);
assert.equal(isQueueControlCommand('/queue resume'), true);
assert.equal(isQueueControlCommand('/queue clear'), true);
assert.equal(isQueueControlCommand('/queue drop'), true);
assert.equal(isQueueControlCommand('/clearqueue'), true);
assert.equal(isQueueControlCommand('/model'), false, 'model command is not a queue command');
assert.equal(isQueueControlCommand('hello'), false, 'plain text is not a queue command');

// ─── isImmediateGoalCommand ─────────────────────────────────────────────────

assert.equal(isImmediateGoalCommand('/goal clear'), true);
assert.equal(isImmediateGoalCommand('/goal pause'), true);
assert.equal(isImmediateGoalCommand('/goal complete'), true);
assert.equal(isImmediateGoalCommand('/goal complete fix the bug'), true);
assert.equal(isImmediateGoalCommand('/goal block waiting for review'), true);
assert.equal(isImmediateGoalCommand('/goal'), false, 'bare /goal is not immediate');
assert.equal(isImmediateGoalCommand('/goal set objective'), false, 'goal set is not immediate');

// ─── isLocalShellLine ───────────────────────────────────────────────────────

assert.equal(isLocalShellLine('!ls -la'), true, '! prefix marks shell command');
assert.equal(isLocalShellLine('!echo hello'), true);
assert.equal(isLocalShellLine('!'), false, 'bare ! is not a shell command');
assert.equal(isLocalShellLine('hello'), false, 'regular text is not a shell command');
assert.equal(isLocalShellLine('/command'), false, 'slash command is not a shell command');

// ─── dropLastQueuedInput ────────────────────────────────────────────────────

{
  const result = dropLastQueuedInput([]);
  assert.deepEqual(result.next, []);
  assert.equal(result.dropped, undefined, 'empty queue drops nothing');
}

{
  const items = [
    { raw: 'a', message: 'a' },
    { raw: 'b', message: 'b' },
  ];
  const result = dropLastQueuedInput(items);
  assert.equal(result.next.length, 1);
  assert.equal(result.dropped.raw, 'b', 'drops the last item');
  assert.equal(result.next[0].raw, 'a', 'keeps earlier items');
}

// ─── sanitizeRenderableText ──────────────────────────────────────────────────

{
  const ansiText = '\x1b[31mHello\x1b[0m World';
  const clean = sanitizeRenderableText(ansiText);
  // Should not crash; control codes should be handled
  assert.ok(typeof clean === 'string', 'returns a string');
}

// ─── renderSkills ────────────────────────────────────────────────────────────

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skills-'));
  try {
    // renderSkills always shows a Skills: summary header
    const rendered = renderSkills(tmpDir);
    assert.ok(rendered.includes('Skills:'), 'shows skills header');
    // May include globally installed skills; the count is shown in the header
    assert.ok(/Skills: \d+ available/.test(rendered), 'shows available skill count');
    assert.ok(rendered.includes('Learned skills'), 'mentions learned skills section');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skills-'));
  try {
    // Add a learned skill file (observational log only, NOT auto-applied by SkillRegistry)
    const learnedDir = path.join(tmpDir, '.moss', 'skills', 'learned');
    fs.mkdirSync(learnedDir, { recursive: true });
    fs.writeFileSync(path.join(learnedDir, 'deploy-prod.md'), '# deploy\nDeploy production.\n', 'utf8');

    const rendered = renderSkills(tmpDir);
    assert.ok(rendered.includes('deploy-prod.md'), 'lists the learned skill file');
    // Learned skills are an observational log — must NOT imply they are active
    assert.ok(rendered.includes('observational log, not auto-applied'), 'labels learned skills as not auto-applied');
    // Should NOT appear as a bare section header that implies active status
    assert.ok(!rendered.match(/^Learned skills:$/m), 'learned skills header clarifies they are not active');
    assert.ok(rendered.includes('/skills forget'), 'shows how to manage learned skills');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
        { type: 'tool_use', name: 'write_file', input: { path: 'hello.js', content: 'function add(a,b){return a+b}' } },
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
  assert.ok(toolRows.some((r) => r.text.includes('write_file') && r.text.includes('hello.js')),
    'write_file row shows tool name + path headline');
  assert.ok(toolRows.some((r) => r.text.includes('exec') && r.text.includes('node verify.js')),
    'exec row shows tool name + command headline');
  // Tool rows come AFTER the assistant prose, in order.
  const assistantIdx = replay.items.findIndex((i) => i.kind === 'assistant');
  assert.ok(assistantIdx >= 0 && toolRows.every((r) => replay.items.indexOf(r) > assistantIdx),
    'tool rows follow the assistant prose that issued them');

  // resumedToolLines: empty for user / text-only turns.
  assert.deepEqual(resumedToolLines(messages[0]), [], 'user message yields no tool lines');
  assert.deepEqual(resumedToolLines(messages[3]), [], 'text-only assistant turn yields no tool lines');
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
