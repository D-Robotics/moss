#!/usr/bin/env node
/**
 * CLI shell command-surface honesty: every command the shell advertises in its
 * key reference has a working handler that PRINTS an inline block — typing it
 * never yields "unknown command". (/quit exits, so it is verified by its branch
 * in the help table only.)
 *
 * This is the gate for M1: the shell's control commands (`/status`, `/model`,
 * `/compact`, `/context`, `/diff`, …) are answered by the shared command
 * registry plus a handful of shell-local handlers, never by the unknown-command
 * path.
 *
 * Retargeted from the Mission Control overlay surface to the v0.22 inline
 * transcript blocks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Hermetic + offline: the control commands resolve CLI config, so point config
// resolution at an empty temp dir and disable the bundled gateway. This must run
// BEFORE `dist/cli/config.js` is imported — that module captures module-level
// defaults at import time — hence the dynamic imports below.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-config-'));
process.env.MOSS_CONFIG_DIR = configDir;
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';

const { HELP_COMMANDS, SHELL_COMMAND_NAMES, SHELL_COMMAND_ROWS } =
  await import('../dist/cli/tui/help.js');
const { setTuiLocale } = await import('../dist/cli/tui/copy.js');
const {
  TuiAppRoot,
  buildHelpOverlayLines,
  shellPaletteRows,
  paletteFrameRows,
  paletteWindowOffset,
} = await import('../dist/cli/tui/app.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');
const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

async function type(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(12);
  }
  instance.stdin.write('\r');
  await sleep(30);
}

/** Type without submitting — the palette is only open while the draft is live. */
async function typeKeys(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(14);
  }
  await sleep(60);
}

/** Send one raw key sequence (arrows, Tab, Enter, Esc) and let ink re-render. */
async function press(instance, sequence) {
  instance.stdin.write(sequence);
  await sleep(70);
}

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

// The advertised surface is HELP_COMMANDS: the same table the `?` / `/help`
// overlay prints, so "advertised" and "handled" cannot drift apart.
const fullHelpText = buildHelpOverlayLines(true).join('\n');
for (const entry of HELP_COMMANDS) {
  assert.ok(fullHelpText.includes(entry), `help advertises ${entry}`);
}
const advertised = HELP_COMMANDS.map((entry) => entry.split(' ')[0]);
assert.ok(advertised.length >= 8, `help advertises >=8 commands (got ${advertised.length})`);

// M1 headline: the control commands that used to fall through to
// "unknown command" must be advertised (and are handled, below).
const HEADLINE = [
  '/model',
  '/mode',
  '/compact',
  '/status',
  '/diff',
  '/export',
  '/doctor',
  '/permissions',
  '/review',
  '/task',
];
for (const command of HEADLINE) {
  assert.ok(advertised.includes(command), `M1: ${command} is advertised by the shell`);
}
for (const folded of ['/quickstart', '/log']) {
  assert.ok(!advertised.includes(folded), `${folded} left the advertised surface`);
}

// ─── C17 / D-8: the `/` menu and `/help` are ONE list ────────────────────────
// Before this fix the menu was the REPL's table filtered down to the shell's
// names: it could only REMOVE rows, so the eleven task/control commands the
// shell owns (/tasks /history /evidence /deployments /failures /resume /queue
// /steer /bg /subs /mcp) were advertised by /help yet missing from the `/` menu.
assert.deepEqual(
  [...SHELL_COMMAND_NAMES],
  advertised,
  'the command table has one bare name per advertised command'
);
assert.equal(
  SHELL_COMMAND_ROWS.length,
  advertised.length,
  'every advertised command has exactly one palette row'
);
const menuAll = shellPaletteRows('/');
assert.equal(
  menuAll.length,
  advertised.length,
  `the / menu offers every advertised command (${menuAll.length} of ${advertised.length})`
);
for (const [command, description] of menuAll) {
  assert.ok(
    advertised.includes(command),
    `the menu never offers an unadvertised command: ${command}`
  );
  assert.ok(
    description.trim() && !description.includes('\n'),
    `${command} has a one-line description`
  );
}
for (const command of advertised) {
  const rows = shellPaletteRows(command).map(([candidate]) => candidate);
  assert.ok(rows.includes(command), `${command} is offered for its own prefix (got ${rows})`);
}
const re = shellPaletteRows('/re').map(([command]) => command);
assert.ok(
  re.includes('/resume') && re.includes('/review'),
  `/re offers /resume and /review (got ${re.join(', ')})`
);
// Task OS is available in the default TUI; loop/goal remain REPL-only until
// they are migrated to the same runtime contract.
assert.ok(
  menuAll.some(([command]) => command === '/task'),
  '/task is offered by the shell menu'
);
for (const replOnly of ['/loop', '/goal', '/init']) {
  assert.ok(
    !menuAll.some(([command]) => command === replOnly),
    `${replOnly} is not offered by the shell menu`
  );
}

// v0.25: the same overlay renders zh chrome under a zh locale. Only moss's own
// wording changes — the command NAMES stay identical, so the advertised surface
// is locale-independent.
{
  const enText = buildHelpOverlayLines(true).join('\n');
  assert.ok(enText.includes('all commands'), 'EN overlay labels the command list in EN');
  assert.ok(!enText.includes('全部命令'), 'EN overlay never prints the zh label');

  setTuiLocale(true);
  const zhText = buildHelpOverlayLines(true).join('\n');
  assert.ok(zhText.includes('全部命令'), 'zh help labels the command list in zh');
  assert.ok(zhText.includes('快捷键'), 'zh help labels the key reference in zh');
  for (const entry of HELP_COMMANDS) {
    assert.ok(zhText.includes(entry), `zh help still advertises ${entry}`);
  }
  setTuiLocale(false);
  assert.ok(
    buildHelpOverlayLines(true).join('\n').includes('all commands'),
    'resetting the locale restores the EN overlay'
  );
}

// Each command must answer with its own named block, not just "something".
const BLOCK_TITLE = new Map([
  ['/help', /^Shortcuts$/],
  ['/status', /^Status$/],
  ['/model', /^Model$/],
  ['/mode', /^Mode$/],
  ['/permissions', /^Permissions$/],
  ['/doctor', /^Doctor$/],
  ['/context', /^Context$/],
  ['/compact', /^Compact$/],
  ['/diff', /^Diff$/],
  ['/review', /^Review$/],
  ['/export', /^Export$/],
  ['/quickstart', /^Quickstart$/],
  ['/usage', /^Usage$/],
  ['/log', /^Log$/],
  ['/stop', /^Stop$/],
  ['/task', /^Task$/],
  ['/tasks', /^Tasks \(\d+\)$/],
  ['/history', /^History \(\d+\)$/],
  ['/evidence', /^Evidence \(\d+\)$/],
  ['/deployments', /^Deployments \(\d+\)$/],
  ['/failures', /^Failures \(\d+\)$/],
  ['/resume', /^Resume$/],
  ['/rewind', /^Checkpoints \(\d+\)$/],
  ['/queue', /^Queue \(/],
  ['/steer', /^Steer$/],
  ['/bg', /^bg$/],
  ['/subs', /^subs$/],
  ['/sessions', /^sessions$/],
  ['/mcp', /^mcp$/],
  ['/hooks', /^Hooks$/],
  ['/jobs', /^Jobs$/],
  ['/skills', /^Skills/],
]);

// Arguments a bare command needs to answer deterministically (the variable part
// of the advertised entry, e.g. `/export [path]`).
const exportPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-export-')),
  'session.md'
);
const ARGS = new Map([
  ['/steer', ' be terse'],
  ['/export', ` ${exportPath}`],
]);

const streamCalls = [];
const agent = {
  steer() {
    return { delivery: 'steer', id: 's', message: '', createdAt: Date.now() };
  },
  asyncTasks: { list: () => [] },
  async compactSession(_sessionKey, instructions) {
    return {
      compacted: true,
      droppedMessages: 3,
      summaryChars: 42,
      tokensAfter: 1234,
      instructions,
    };
  },
  config: {
    model: 'spec-model',
    contextTokens: 100_000,
    sessionStore: {
      loadMessages: async () => [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    },
  },
  tools: { getAll: () => [], getNames: () => [], size: 0 },
  async *streamChat(_sk, message) {
    streamCalls.push(message);
    yield {
      type: 'done',
      result: { response: `ok ${message.slice(0, 6)}`, stopReason: 'end_turn' },
    };
  },
};
const options = {
  agent,
  // A git workspace WITH a diff, built for the test: `/diff` and `/review`
  // then take their happy paths deterministically — independent of the host
  // git version's exit codes and of any temp-dir quirks.
  workspaceDir: (() => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-ws-'));
    fs.writeFileSync(path.join(ws, 'note.txt'), 'v1\n');
    const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8', timeout: 10_000 });
    git(['init', '-q']);
    git(['config', 'user.email', 'spec@moss']);
    git(['config', 'user.name', 'moss-spec']);
    git(['add', 'note.txt']);
    git(['commit', '-q', '-m', 'init']);
    fs.writeFileSync(path.join(ws, 'note.txt'), 'v2\n');
    fs.writeFileSync(path.join(ws, 'extra.txt'), 'new\n');
    return ws;
  })(),
  listSessions: async () => [],
  mcpServers: [],
  listCheckpoints: () => [],
};

for (const command of advertised) {
  if (command === '/quit') continue; // exits the app — verified by name only
  // `/clear` answers by REMOVING rows, not by printing a block: the transcript
  // shrinks to the banner and a summary note. It gets its own assertion shape.
  if (command === '/clear') {
    const handle = liveHandle();
    const runtime = new TaskRuntime({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-')),
    });
    const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
    const booted = await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
    assert.ok(booted, '/clear: shell booted');
    await type(instance, '/help');
    await waitFor(() => instance.lastFrame().includes('Help · Esc or Enter to close'));
    await press(instance, '\r');
    await type(instance, '/clear');
    const cleared = await waitFor(() =>
      handle.store.rows.some((r) => r.kind === 'summary' && r.text.includes('transcript cleared'))
    );
    assert.ok(cleared, '/clear leaves its note');
    assert.ok(
      handle.store.rows.every((r) => r.kind === 'banner' || r.kind === 'summary'),
      '/clear drops every non-banner row'
    );
    assert.ok(
      !handle.store.rows.some((r) => r.text.includes('unknown command')),
      '/clear must not be answered "unknown command"'
    );
    instance.unmount();
    await sleep(100);
    continue;
  }
  if (command === '/model') {
    const handle = liveHandle();
    const runtime = new TaskRuntime({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-model-')),
    });
    const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
    await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
    await type(instance, '/model');
    assert.ok(
      await waitFor(() => instance.lastFrame().includes('Select model')),
      'model command opens an inline picker instead of dumping the catalog into scrollback'
    );
    instance.unmount();
    await sleep(100);
    continue;
  }
  if (command === '/help') {
    const handle = liveHandle();
    const runtime = new TaskRuntime({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-help-')),
    });
    const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
    await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
    await type(instance, '/help');
    assert.ok(await waitFor(() => instance.lastFrame().includes('Help · Esc or Enter to close')));
    await press(instance, '\x1b');
    await waitFor(() => !instance.lastFrame().includes('Help · Esc or Enter to close'));
    // `/help --all` is the promised full-reference entry and must not be dead.
    await type(instance, '/help --all');
    const full = await waitFor(() => instance.lastFrame().includes('Help · full reference'));
    assert.ok(full, '/help --all opens the full command reference');
    instance.unmount();
    await sleep(100);
    continue;
  }
  const title = BLOCK_TITLE.get(command);
  assert.ok(title, `${command} has an expected block title in this spec`);
  const arg = ARGS.get(command) ?? '';
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-')),
  });
  const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
  const booted = await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  assert.ok(booted, `${command}: shell booted`);
  await type(instance, `${command}${arg}`);
  const handled = await waitFor(() =>
    handle.store.rows.some((r) => r.kind === 'tool' && title.test(r.text))
  );
  const unknown = handle.store.rows.some((r) => r.text.includes('unknown command'));
  assert.ok(
    handled,
    `${command} produced its inline block (rows: ${JSON.stringify(
      handle.store.rows.map((r) => `${r.kind}:${r.text}`).slice(-3)
    )})`
  );
  assert.ok(!unknown, `${command} must not be answered "unknown command"`);
  instance.unmount();
  await sleep(100);
}

// The whole control surface, typed back to back with no "unknown command" among
// them: the M1 regression that started this work. Each command waits for its
// own block before the next keystroke — a slow runner must not turn
// still-settling async answers (e.g. /review's git spawn) into false reds.
{
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-all-')),
  });
  const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  for (const command of HEADLINE) {
    if (command === '/model') continue;
    await type(instance, `${command}${ARGS.get(command) ?? ''}`);
    const title = BLOCK_TITLE.get(command);
    const settled = await waitFor(
      () =>
        title !== undefined &&
        handle.store.rows.some((r) => r.kind === 'tool' && title.test(r.text)),
      15_000
    );
    assert.ok(settled, `M1: ${command} answered inline`);
  }
  const unknown = handle.store.rows.filter(
    (r) => r.kind === 'error' && r.text.includes('unknown command')
  );
  assert.equal(
    unknown.length,
    0,
    `no control command fell through: ${JSON.stringify(unknown.map((r) => r.text))}`
  );
  instance.unmount();
  await sleep(100);
}

// The mounted shell must actually FEED the menu from that table (the pure helper
// above would keep passing if app.ts went back to filtering the REPL table).
{
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-cmd-menu-')),
  });
  const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await typeKeys(instance, '/');
  const expectedMore = advertised.length - 8;
  const opened = await waitFor(() => instance.lastFrame().includes(`… ${expectedMore} more`));
  assert.ok(
    opened,
    `/ offers the whole surface (${advertised.length} rows → 8 shown + "… ${expectedMore} more"): ${JSON.stringify(
      instance.lastFrame().slice(0, 200)
    )}`
  );
  assert.ok(instance.lastFrame().includes('/status'), 'the menu leads with the everyday commands');
  await typeKeys(instance, 're');
  const filtered = await waitFor(() => instance.lastFrame().includes('/resume'));
  assert.ok(
    filtered,
    `/re offers the task-resume command: ${JSON.stringify(instance.lastFrame().slice(0, 300))}`
  );
  assert.ok(instance.lastFrame().includes('/review'), '/re also offers /review');
  instance.unmount();
  await sleep(100);
}

// ─── D-15: the marked row IS the row Enter runs and Tab completes ────────────
// `renderSlashPalette` draws at most PALETTE_MAX_ROWS rows, so an absolute
// selection beyond the window used to be clamped for the marker only: the menu
// highlighted `/sessions` while Enter ran `/doctor`. The window must follow the
// cursor, and the marker index handed to the renderer must be the same row the
// shell acts on.
{
  const rows = shellPaletteRows('/');
  const doctorIndex = rows.findIndex(([command]) => command === '/doctor');
  assert.ok(doctorIndex >= 0, 'the palette contains /doctor');
  const lastCommand = rows[rows.length - 1][0];
  assert.ok(
    typeof lastCommand === 'string' && lastCommand.startsWith('/') && !lastCommand.includes(' '),
    `the palette ends with a dispatchable command row (got ${lastCommand})`
  );

  // Pure windowing contract: the window contains the cursor and never grows.
  assert.equal(paletteWindowOffset(0, rows.length, 8), 0, 'the first row starts the window');
  assert.equal(paletteWindowOffset(7, rows.length, 8), 0, 'row 8 still fits the window');
  assert.equal(paletteWindowOffset(8, rows.length, 8), 1, 'row 9 scrolls the window');
  assert.equal(
    paletteWindowOffset(rows.length - 1, rows.length, 8),
    rows.length - 8,
    'the last row uses the tail window'
  );
  assert.equal(paletteWindowOffset(3, 4, 8), 0, 'a short menu never scrolls');
  const selections = [0, 7, 8, 9, rows.length - 1].filter(
    (selected, index, all) => selected >= 0 && selected < rows.length && all.indexOf(selected) === index
  );
  for (const selected of selections) {
    const offset = paletteWindowOffset(selected, rows.length, 8);
    const frame = paletteFrameRows(rows, offset, 8);
    const relative = selected - offset;
    assert.ok(relative >= 0 && relative < 8, `row ${selected} stays inside the window`);
    assert.equal(frame[relative][0], rows[selected][0], `the marker row is row ${selected}`);
    assert.equal(frame.length, rows.length, 'hidden rows only feed the "… N more" counter');
  }

  const mountMenu = async (suffix) => {
    const handle = liveHandle();
    const runtime = new TaskRuntime({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), `moss-tui-cmd-${suffix}-`)),
    });
    const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
    await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
    return { instance, handle };
  };

  // Moving to the /doctor row then pressing Enter runs the marked command.
  {
    const { instance, handle } = await mountMenu('d15-enter');
    await typeKeys(instance, '/');
    for (let i = 0; i < doctorIndex; i += 1) await press(instance, '\x1b[B');
    const marked = await waitFor(() => instance.lastFrame().includes('❯ /doctor'));
    assert.ok(
      marked,
      `the marker follows the cursor past the window: ${JSON.stringify(
        instance.lastFrame().slice(0, 300)
      )}`
    );
    assert.ok(
      !instance.lastFrame().includes('❯ /sessions'),
      'the marker is not one row behind the cursor'
    );
    await press(instance, '\r');
    const ran = await waitFor(() =>
      handle.store.rows.some((r) => r.kind === 'tool' && r.text === 'Doctor')
    );
    assert.ok(
      ran,
      `Enter ran the marked command, not another row: ${JSON.stringify(
        handle.store.rows.map((r) => `${r.kind}:${r.text}`).slice(-3)
      )}`
    );
    instance.unmount();
    await sleep(100);
  }

  // Move to /doctor then Tab: the composer receives the marked command.
  {
    const { instance } = await mountMenu('d15-tab');
    await typeKeys(instance, '/');
    for (let i = 0; i < doctorIndex; i += 1) await press(instance, '\x1b[B');
    await press(instance, '\t');
    await press(instance, '\x1b'); // close the menu: only the composer keeps a ❯
    const completed = await waitFor(() => instance.lastFrame().includes('❯ /doctor'));
    assert.ok(
      completed,
      `Tab completed the marked command: ${JSON.stringify(instance.lastFrame().slice(0, 300))}`
    );
    assert.ok(
      !instance.lastFrame().includes('/quickstart'),
      'Tab did not complete a row the marker was not on'
    );
    instance.unmount();
    await sleep(100);
  }

  // Wrap upwards from row 0 → the tail window marks the LAST row, and Enter runs it.
  {
    const { instance, handle } = await mountMenu('d15-wrap');
    await typeKeys(instance, '/');
    await press(instance, '\x1b[A');
    const last = rows[rows.length - 1][0];
    const marked = await waitFor(() => instance.lastFrame().includes(`❯ ${last}`));
    assert.ok(
      marked,
      `↑ wraps to the last row (${last}) in the tail window: ${JSON.stringify(
        instance.lastFrame().slice(0, 300)
      )}`
    );
    await press(instance, '\r');
    const title = BLOCK_TITLE.get(last);
    const ran = await waitFor(() =>
      last === '/clear'
        ? handle.store.rows.some(
            (r) => r.kind === 'summary' && /transcript cleared/.test(r.text)
          )
        : title !== undefined &&
          handle.store.rows.some((r) => r.kind === 'tool' && title.test(r.text))
    );
    assert.ok(
      ran,
      `Enter ran the wrapped-to command: ${JSON.stringify(
        handle.store.rows.map((r) => `${r.kind}:${r.text}`).slice(-3)
      )}`
    );
    instance.unmount();
    await sleep(100);
  }
}

void streamCalls;

// ─── D5: task artifacts fold into /task view; /jobs merges bg+subs ──────────
// The merged-away tokens keep dispatching (back-compat) while leaving the
// advertised catalog.
{
  const hasBlock = (handle, title) =>
    handle.store.rows.some((r) => r.kind === 'tool' && title.test(r.text));
  const mount = async (suffix) => {
    const handle = liveHandle();
    const runtime = new TaskRuntime({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), `moss-tui-cmd-${suffix}-`)),
    });
    const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
    await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
    return { instance, handle };
  };
  {
    const { instance, handle } = await mount('d5-view');
    await type(instance, '/task view evidence');
    assert.ok(
      await waitFor(() => hasBlock(handle, /^Evidence \(\d+\)$/)),
      '/task view evidence prints the Evidence block'
    );
    await type(instance, '/task view');
    assert.ok(
      await waitFor(() => hasBlock(handle, /^Tasks \(\d+\)$/)),
      'bare /task view defaults to tasks'
    );
    await type(instance, '/tasks');
    assert.ok(
      await waitFor(
        () =>
          handle.store.rows.filter((r) => r.kind === 'tool' && /^Tasks \(\d+\)$/.test(r.text))
            .length >= 2
      ),
      'legacy /tasks still dispatches after the merge'
    );
    await type(instance, '/task view bogus');
    assert.ok(
      await waitFor(() => instance.lastFrame().includes('unknown kind "bogus"')),
      'an unknown kind gets a one-line corrective hint'
    );
    instance.unmount();
    await sleep(100);
  }
  {
    const { instance, handle } = await mount('d5-jobs');
    await type(instance, '/jobs');
    assert.ok(await waitFor(() => hasBlock(handle, /^Jobs$/)), '/jobs prints the combined block');
    assert.ok(instance.lastFrame().includes('sub-agents:'), '/jobs includes the sub-agent section');
    await type(instance, '/bg');
    assert.ok(
      await waitFor(() => handle.store.rows.some((r) => r.kind === 'tool' && r.text === 'bg')),
      'legacy /bg still dispatches after the merge'
    );
    instance.unmount();
    await sleep(100);
  }
  // Folded-away /quickstart and /log keep dispatching (back-compat).
  {
    const { instance, handle } = await mount('closeout-fold');
    await type(instance, '/quickstart');
    assert.ok(
      await waitFor(() => hasBlock(handle, /^Quickstart$/)),
      'legacy /quickstart still dispatches'
    );
    await type(instance, '/log');
    assert.ok(await waitFor(() => hasBlock(handle, /^Log$/)), 'legacy /log still dispatches');
    instance.unmount();
    await sleep(100);
  }
}

console.log('[PASS] TUI command surface honesty (advertised + discoverable + marker==action)');
