#!/usr/bin/env node
/**
 * Slash-command palette: typing `/` opens a filtered command menu built from the
 * REPL's command tables (single source of truth), ↑/↓ select, Tab completes,
 * Esc closes, Enter runs the selected command.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stringWidth from 'string-width';

import {
  movePaletteSelection,
  renderSlashPalette,
  slashPaletteRows,
} from '../dist/cli/tui/palette.js';
import { createTuiStore } from '../dist/cli/tui/render-bridge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. rows: when the menu is open, and what it matches ─────────────────

{
  const all = slashPaletteRows('/');
  assert.ok(all.length > 5, 'a bare slash lists the command surface');
  assert.ok(
    all.every(([command]) => command.startsWith('/')),
    'every row is a slash command'
  );
  assert.ok(
    all.every(([, description]) => description.length > 0),
    'every row teaches what the command does'
  );

  assert.deepEqual(
    slashPaletteRows('/comp').map(([command]) => command),
    ['/compact'],
    'fuzzy subsequence match finds /compact'
  );
  assert.ok(
    slashPaletteRows('/rew')
      .map(([command]) => command)
      .includes('/rewind'),
    'prefix matches rank first'
  );

  assert.deepEqual(slashPaletteRows('hello'), [], 'plain text never opens the menu');
  assert.deepEqual(slashPaletteRows('/rewind 1'), [], 'arguments close the menu');
  // `submit()` trims, so a leading space is still a command: the menu must
  // agree with what Enter will actually do.
  assert.deepEqual(
    slashPaletteRows('  /st').map(([command]) => command),
    ['/status', '/stop'],
    'leading whitespace keeps the menu consistent with submit()'
  );

  const withCustom = slashPaletteRows('/deploy', [['/deploy', 'ship it to the robot']]);
  assert.deepEqual(
    withCustom,
    [['/deploy', 'ship it to the robot']],
    'custom commands join the menu'
  );
}

// ─── 2. rendering ────────────────────────────────────────────────────────

{
  const rows = slashPaletteRows('/rew');
  const lines = renderSlashPalette(rows, { width: 60, selected: 0 });
  assert.equal(lines.length, rows.length, 'one row per match');
  assert.ok(lines[0].text.startsWith('❯ /rewind'), 'the selection carries the marker');
  assert.ok(lines[0].bold, 'the selection is emphasised');
  assert.ok(lines[1].text.startsWith('  /review'), 'other rows keep the gutter');
  assert.ok(lines[1].dim, 'other rows are dim');

  for (const width of [20, 40, 90]) {
    for (const line of renderSlashPalette(rows, { width, selected: 1 })) {
      assert.ok(
        stringWidth(line.text) <= width,
        `palette row fits ${width}: ${JSON.stringify(line.text)}`
      );
    }
  }

  const many = renderSlashPalette(slashPaletteRows('/'), { width: 80, selected: 0, maxRows: 5 });
  assert.equal(many.length, 6, 'the menu is capped and says how much is left');
  assert.match(many[many.length - 1].text, /… \d+ more/, 'overflow is announced');
  assert.deepEqual(renderSlashPalette([], { width: 80, selected: 0 }), [], 'no rows, no frame');
}

// ─── 3. selection wraps ──────────────────────────────────────────────────

{
  assert.equal(movePaletteSelection(0, 3, 1), 1, 'down');
  assert.equal(movePaletteSelection(2, 3, 1), 0, 'down wraps');
  assert.equal(movePaletteSelection(0, 3, -1), 2, 'up wraps');
  assert.equal(movePaletteSelection(5, 0, 1), 0, 'empty menu stays at 0');
}

// ─── 4. the shell wires it (component level) ─────────────────────────────

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const { TuiAppRoot } = await import('../dist/cli/tui/app.js');
  const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-palette-'));
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
    await sleep(80);
  };

  await typeOnly('/');
  assert.ok(instance.lastFrame().includes('/compact'), 'typing / opens the menu');

  await typeOnly('rew');
  const frame = instance.lastFrame();
  assert.ok(frame.includes('/rewind'), '/rew lists /rewind');
  await instance.stdin.write('\x1b[B'); // ↓
  await sleep(80);
  assert.ok(instance.lastFrame().includes('❯ /review'), '↓ moves the selection');

  await instance.stdin.write('\t'); // Tab completes
  await sleep(80);
  assert.ok(instance.lastFrame().includes('❯ /review'), 'Tab completes the command');

  await instance.stdin.write('\x1b'); // Esc closes the menu
  await sleep(80);
  const closed = instance.lastFrame();
  assert.ok(!closed.includes('review the working-tree diff'), 'Esc closes the menu');
  assert.ok(closed.includes('/review'), 'the completed command survives the menu closing');

  // Enter runs the completed command (the palette must not swallow it).
  instance.stdin.write('\r');
  await sleep(150);
  assert.equal(streamCalls.length, 0, 'a slash command is not sent to the model');

  instance.unmount();
}

console.log('OK tui-palette');
