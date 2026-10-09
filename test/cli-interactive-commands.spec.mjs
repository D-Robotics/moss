#!/usr/bin/env node
/**
 * Interactive slash-command catalog — tested from the user's perspective:
 * what commands are available, how they're organized, and how autocomplete works.
 */
import assert from 'node:assert/strict';

import {
  INTERACTIVE_COMMAND_SECTIONS,
  SLASH_MENU_ROWS,
  INTERACTIVE_COMPLETION_COMMANDS,
  commandRowsForSlashInput,
  formatInteractiveCommandSections,
} from '../dist/cli/interactive-commands.js';
import { SHELL_COMMANDS } from '../dist/cli/tui/help.js';

// ─── Command sections are organized and complete ──────────────────────────────

{
  const titles = INTERACTIVE_COMMAND_SECTIONS.map((s) => s.title);
  for (const expected of ['Work', 'Inspect', 'Configure', 'Control']) {
    assert.ok(titles.includes(expected), `section "${expected}" exists in the command catalog`);
  }
}

// ─── Critical commands are visible ───────────────────────────────────────────

{
  const allVisible = INTERACTIVE_COMMAND_SECTIONS.flatMap((s) => s.rows)
    .filter((r) => !r.hidden)
    .map((r) => r.command);
  // Commands may include argument descriptions in their names (e.g. "/connect <ip>")
  const hasCmd = (prefix) => allVisible.some((c) => c === prefix || c.startsWith(prefix + ' '));
  for (const cmd of ['/help', '/model', '/compact', '/goal', '/plan', '/diff', '/review']) {
    assert.ok(hasCmd(cmd), `critical command "${cmd}" is visible in the catalog`);
  }
  assert.ok(!hasCmd('/status'), '/status stays out of the everyday menu');
  assert.ok(!hasCmd('/export'), '/export stays out of the everyday menu');
  assert.ok(!hasCmd('/task'), '/task stays hidden — everyday work is /goal');
  assert.ok(
    !hasCmd('/mode'),
    '/mode stays hidden — Shift+Tab, /plan, and /permissions switch modes'
  );
  assert.ok(!hasCmd('/loop'), '/loop is not a catalog command');
}

// ─── formatInteractiveCommandSections — structured help text ─────────────────

{
  // Returns an array of strings (one per section line)
  const lines = formatInteractiveCommandSections({ locale: 'en', includeHidden: false });
  assert.ok(Array.isArray(lines), 'formatInteractiveCommandSections returns an array');
  const joined = lines.join('\n');
  assert.ok(joined.includes('/help'), 'formatted commands include /help');
  assert.ok(joined.includes('/compact'), 'formatted commands include /compact');
  assert.ok(joined.includes('/model'), 'formatted commands include /model');
  assert.ok(joined.includes('/goal'), 'formatted commands include /goal');
  assert.ok(joined.includes('/plan'), 'formatted commands include /plan');
  assert.ok(joined.includes('/diff'), 'formatted commands include /diff');
  assert.ok(!joined.includes('/sessions'), 'hidden /sessions stays out of the everyday help');
  assert.ok(!/\n\s*\/task\b/.test(joined), 'hidden /task stays out of the everyday help');
  assert.ok(!/\n\s*\/mode\b/.test(joined), 'hidden /mode stays out of the everyday help');
}

// ─── Slash menu for autocomplete ─────────────────────────────────────────────
// commandRowsForSlashInput returns [command, description] tuples

{
  // A bare '/' should return all visible menu rows
  const rows = commandRowsForSlashInput('/');
  assert.ok(rows.length > 5, 'typing "/" shows multiple commands');
  for (const [cmd] of rows) {
    assert.ok(typeof cmd === 'string' && cmd.startsWith('/'), 'all menu rows start with /');
  }
}

{
  // Prefix filtering narrows results
  const rows = commandRowsForSlashInput('/mo');
  assert.ok(
    rows.some(([cmd]) => cmd === '/model' || cmd.startsWith('/model')),
    'typing "/mo" surfaces /model'
  );
}

{
  // Fuzzy matching handles small typos (subsequence: "/modl" ⊂ "/model")
  const rows = commandRowsForSlashInput('/modl');
  assert.ok(
    rows.some(([cmd]) => cmd === '/model' || cmd.startsWith('/model')),
    'typo "/modl" still finds /model'
  );
}

{
  // Unknown prefix returns empty or minimal results, doesn't crash
  const rows = commandRowsForSlashInput('/zzz');
  assert.ok(Array.isArray(rows), 'unknown prefix returns array without crashing');
}

// ─── INTERACTIVE_COMPLETION_COMMANDS includes slash aliases ──────────────────

{
  for (const cmd of ['/help', '/model', '/compact', '/diff', '/review']) {
    assert.ok(INTERACTIVE_COMPLETION_COMMANDS.includes(cmd), `completion list includes "${cmd}"`);
  }
}

// ─── SLASH_MENU_ROWS excludes hidden commands ─────────────────────────────────

{
  for (const row of SLASH_MENU_ROWS) {
    assert.ok(!row.hidden, 'SLASH_MENU_ROWS contains only non-hidden commands');
  }
}

// ─── No duplicate commands in menu ───────────────────────────────────────────

{
  const commands = SLASH_MENU_ROWS.map((r) => r.command);
  const unique = new Set(commands);
  assert.equal(unique.size, commands.length, 'no duplicate command entries in the menu');
}

// ─── Everyday menu vs hidden aliases (both surfaces still dispatch) ─────────

{
  // Retired names are not catalog rows. Hidden rows stay dispatchable and out
  // of the everyday menu. /clear, /goal, /plan, and /resume answer on both
  // surfaces.
  const retired = [
    '/loop',
    '/history',
    '/evidence',
    '/deployments',
    '/failures',
    '/jobs',
    '/bg',
    '/subs',
    '/sessions',
    '/quickstart',
    '/log',
  ];
  const hidden = ['/steer', '/queue', '/task', '/mode', '/init', '/stop'];
  const menu = new Set([
    ...SLASH_MENU_ROWS.map((row) => row.command),
    ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
    ...INTERACTIVE_COMPLETION_COMMANDS,
  ]);
  const catalogRows = INTERACTIVE_COMMAND_SECTIONS.flatMap((s) => s.rows);
  const everydayCommands = new Set(
    formatInteractiveCommandSections({ includeHidden: false })
      .map((line) => line.trim().split(/\s+/, 1)[0] ?? '')
      .filter((token) => token.startsWith('/'))
  );
  for (const cmd of retired) {
    assert.ok(!menu.has(cmd), `retired command "${cmd}" is not in the everyday menu`);
    assert.ok(
      !catalogRows.some((row) => row.command === cmd),
      `retired command "${cmd}" is gone from the catalog`
    );
  }
  for (const cmd of hidden) {
    assert.ok(!menu.has(cmd), `hidden command "${cmd}" stays out of the everyday menu`);
    const row = catalogRows.find((entry) => entry.command === cmd);
    assert.ok(row, `hidden command "${cmd}" still exists in the catalog`);
    assert.equal(row.hidden, true, `"${cmd}" is marked hidden`);
    assert.ok(!everydayCommands.has(cmd), `"${cmd}" is absent from everyday help`);
  }
  for (const cmd of ['/goal', '/plan', '/resume', '/clear', '/help']) {
    assert.ok(menu.has(cmd), `everyday command "${cmd}" is in the menu`);
  }
  const fullHelp = formatInteractiveCommandSections({ includeHidden: true }).join('\n');
  assert.ok(fullHelp.includes('/task'), 'hidden /task is listed when help includes hidden rows');
  assert.ok(fullHelp.includes('/init'), 'hidden /init is listed when help includes hidden rows');
}

// ─── One catalog: the TUI table is a pure projection of it ──────────────────

{
  const rows = INTERACTIVE_COMMAND_SECTIONS.flatMap((s) => s.rows);
  const commands = rows.map((row) => row.command);
  assert.equal(
    new Set(commands).size,
    commands.length,
    'the catalog has no duplicate command tokens'
  );
  const byCommand = new Map(rows.map((row) => [row.command, row]));
  for (const row of rows) {
    assert.ok(
      !row.surfaces || row.surfaces.length > 0,
      `${row.command} declares a non-empty surfaces list`
    );
  }
  for (const entry of SHELL_COMMANDS) {
    const row = byCommand.get(entry.command);
    assert.ok(row, `TUI command ${entry.command} exists in the shared catalog`);
    assert.equal(
      entry.description,
      row.description,
      `${entry.command} description comes from the catalog`
    );
    const usage = row.args ? `${row.command} ${row.args}` : row.command;
    assert.equal(entry.usage, usage, `${entry.command} usage comes from the catalog`);
    assert.ok(
      !row.surfaces || row.surfaces.includes('tui'),
      `${entry.command} is marked available on the tui surface`
    );
  }
  for (const name of ['/loop', '/init', '/task', '/mode']) {
    assert.ok(
      !SHELL_COMMANDS.some((entry) => entry.command === name),
      `${name} stays out of the everyday TUI menu`
    );
  }
  const tuiCommands = SHELL_COMMANDS.map((entry) => entry.command);
  for (const merged of [
    '/tasks',
    '/history',
    '/evidence',
    '/deployments',
    '/failures',
    '/bg',
    '/subs',
    '/jobs',
  ]) {
    assert.ok(!tuiCommands.includes(merged), `${merged} is no longer in the everyday menu`);
  }
  assert.ok(tuiCommands.includes('/goal'), '/goal is the everyday work-until entry');
  assert.ok(tuiCommands.includes('/plan'), '/plan is in the everyday menu');
  assert.ok(!tuiCommands.includes('/task'), '/task stays hidden');
  assert.ok(tuiCommands.includes('/permissions'), '/permissions stays advertised');
  const taskRow = byCommand.get('/task');
  assert.equal(taskRow?.hidden, true, '/task is a hidden Task OS entry');
  assert.ok(taskRow?.args?.includes('view'), '/task advertises the view subcommand');
  assert.ok(taskRow?.args?.includes('verify'), '/task advertises verify');
  assert.ok(
    SHELL_COMMANDS.length <= 25,
    `the TUI command surface keeps shrinking (got ${SHELL_COMMANDS.length})`
  );
  for (const folded of ['/quickstart', '/log']) {
    assert.ok(
      !tuiCommands.includes(folded),
      `${folded} left the catalog (info rides on /status and /doctor)`
    );
  }
}

console.log('[PASS] Interactive slash commands');
