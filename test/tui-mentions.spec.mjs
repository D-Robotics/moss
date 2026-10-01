#!/usr/bin/env node
/**
 * `@` file mentions: typing an `@token` opens a filtered workspace-file menu,
 * Tab completes the path into the composer (without running anything), and the
 * index stays bounded and ignore-aware.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stringWidth from 'string-width';

import {
  completeMention,
  filterMentions,
  mentionTokenAt,
  renderMentionMenu,
  workspaceFileIndex,
} from '../dist/cli/tui/mentions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. token detection ──────────────────────────────────────────────────

{
  assert.deepEqual(mentionTokenAt('@src', 4), { start: 0, end: 4, query: 'src' }, 'leading @token');
  assert.deepEqual(
    mentionTokenAt('look at @src/cli', 16),
    { start: 8, end: 16, query: 'src/cli' },
    'a word-boundary @ anywhere in the draft opens the menu'
  );
  assert.equal(mentionTokenAt('foo@bar', 7), null, 'an email-like @ is not a mention');
  assert.equal(mentionTokenAt('@src/cli tu', 11), null, 'a space ends the token');
  assert.equal(mentionTokenAt('no mention here', 15), null, 'no @, no menu');
  assert.equal(mentionTokenAt('@', 1)?.query, '', 'a bare @ lists everything');
}

// ─── 2. the index is bounded, ignore-aware and ordered ───────────────────

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-mentions-'));
  fs.mkdirSync(path.join(root, 'src', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'src', 'cli', 'app.ts'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'deep.js'), 'x');

  const index = workspaceFileIndex(root);
  const paths = index.map((entry) => entry.path);
  assert.ok(paths.includes('src/'), 'directories are listed with a trailing slash');
  assert.ok(paths.includes('src/cli/app.ts'), 'nested files are listed');
  assert.ok(paths.includes('README.md'), 'root files are listed');
  assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules is never walked');
  assert.ok(paths.indexOf('src/') < paths.indexOf('README.md'), 'directories sort before files');
  assert.ok(workspaceFileIndex(root, 3).length <= 3, 'the index honours its limit');
}

// ─── 3. filtering and completion ─────────────────────────────────────────

{
  const index = workspaceFileIndex(process.cwd());
  assert.ok(index.length > 10, 'the repo index is populated');
  const filtered = filterMentions(index, 'app.ts');
  assert.ok(
    filtered.some((entry) => entry.path.endsWith('app.ts')),
    'substring search finds app.ts'
  );
  assert.ok(filterMentions(index, 'zzzzz').length === 0, 'a non-match yields nothing');
  assert.ok(filterMentions(index, '', 4).length === 4, 'the limit is honoured');

  // 'look @src rest': the '@' is at index 5 and the token spans 5..9.
  const token = { start: 5, end: 9, query: 'src' };
  const completed = completeMention('look @src rest', token, { path: 'src/cli/', directory: true });
  assert.equal(completed.value, 'look @src/cli/ rest', 'the token is replaced in place');
  assert.equal(completed.caret, 'look @src/cli/'.length, 'the caret lands after the insertion');

  const file = completeMention(
    '@rea',
    { start: 0, end: 4, query: 'rea' },
    {
      path: 'README.md',
      directory: false,
    }
  );
  assert.equal(file.value, '@README.md ', 'a file completion adds a trailing space to keep typing');
}

// ─── 4. the menu renders inside the pane ─────────────────────────────────

{
  const entries = [
    { path: 'src/', directory: true },
    { path: 'src/cli/app.ts', directory: false },
  ];
  const lines = renderMentionMenu(entries, { width: 40, selected: 0 });
  assert.equal(lines.length, 2, 'one row per entry');
  assert.ok(lines[0].text.startsWith('❯ @src/'), 'the selection is marked');
  assert.ok(lines[0].text.includes('dir'), 'directories are labelled');
  assert.ok(lines[1].text.includes('file'), 'files are labelled');
  for (const width of [16, 30, 90]) {
    for (const line of renderMentionMenu(entries, { width, selected: 1 })) {
      assert.ok(
        stringWidth(line.text) <= width,
        `mention row fits ${width}: ${JSON.stringify(line.text)}`
      );
    }
  }
  assert.deepEqual(renderMentionMenu([], { width: 40, selected: 0 }), [], 'no entries, no menu');
}

// ─── 5. the shell wires it: @ opens, filters, Tab completes ──────────────

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const { TuiAppRoot } = await import('../dist/cli/tui/app.js');
  const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
  const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-mention-shell-'));
  fs.writeFileSync(path.join(ws, 'alpha.txt'), 'a');
  fs.mkdirSync(path.join(ws, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'nested', 'beta.ts'), 'b');

  const runtime = new TaskRuntime({ workspaceDir: ws });
  await runtime.refresh();
  const listeners = new Set();
  const handle = {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const streamCalls = [];
  const agent = {
    asyncTasks: { list: () => [] },
    async *streamChat(sessionKey, message) {
      streamCalls.push({ sessionKey, message });
      yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
    },
  };
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent,
        workspaceDir: ws,
        model: 'model-x',
        version: '0.22.0',
        listSessions: async () => [],
        mcpServers: [],
        listCheckpoints: () => [],
      },
      handle,
      runtime,
    })
  );
  await sleep(80);
  const typeOnly = async (value) => {
    for (const ch of value) {
      instance.stdin.write(ch);
      await sleep(15);
    }
    await sleep(100);
  };

  await typeOnly('@');
  const opened = instance.lastFrame();
  assert.ok(opened.includes('@alpha.txt'), 'typing @ lists workspace files');
  assert.ok(opened.includes('@nested/'), 'directories are listed too');

  await typeOnly('alp');
  const filtered = instance.lastFrame();
  assert.ok(filtered.includes('@alpha.txt'), '@alp keeps alpha.txt');
  assert.ok(!filtered.includes('@nested/'), '@alp filters nested/ out');

  await instance.stdin.write('\t');
  await sleep(120);
  const completed = instance.lastFrame();
  assert.ok(completed.includes('@alpha.txt'), 'Tab completes the path into the composer');
  assert.equal(streamCalls.length, 0, 'completing never runs anything');

  instance.unmount();
}

console.log('OK tui-mentions');
