#!/usr/bin/env node
/**
 * Interactive slash-command catalog — tested from the user's perspective:
 * what commands are available, how they're organized, and how autocomplete works.
 */
import assert from 'node:assert/strict';

import {
  INTERACTIVE_COMMAND_SECTIONS,
  REPL_COMMAND_SECTIONS,
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
  for (const cmd of ['/help', '/model', '/status', '/compact', '/task', '/diff', '/review']) {
    assert.ok(hasCmd(cmd), `critical command "${cmd}" is visible in the catalog`);
  }
  // First-principles closeout: one advertised autonomous entry (/task), with
  // /loop retired to a hidden alias like /goal.
  const loopRow = INTERACTIVE_COMMAND_SECTIONS.flatMap((s) => s.rows).find(
    (r) => r.command === '/loop'
  );
  assert.equal(loopRow?.hidden, true, '/loop is a hidden compat alias of /task run');
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
  assert.ok(joined.includes('/diff'), 'formatted commands include /diff');
  assert.ok(!joined.includes('/sessions'), 'hidden /sessions stays out of the everyday help');
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
  for (const cmd of ['/help', '/model', '/status', '/compact', '/diff']) {
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

// ─── Commands without REPL handlers are never advertised to the REPL ────────

{
  // Two groups after the D5 merge:
  //  - folded-away task-artifact tokens (/tasks /history /evidence /deployments
  //    /failures /bg /subs) left the catalog entirely — they still dispatch in
  //    the shell via /task view and /jobs back-compat, but are advertised nowhere;
  //  - tui-only commands (/steer /queue /clear /resume /mcp /log /hooks) live in
  //    the catalog marked surfaces:['tui'], absent from every REPL projection.
  const folded = [
    '/tasks',
    '/history',
    '/evidence',
    '/deployments',
    '/failures',
    '/bg',
    '/subs',
    '/quickstart',
    '/log',
  ];
  const tuiOnly = ['/steer', '/queue', '/clear', '/resume', '/mcp', '/hooks'];
  const tokens = new Set([
    ...SLASH_MENU_ROWS.map((row) => row.command),
    ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
    ...INTERACTIVE_COMPLETION_COMMANDS,
    ...REPL_COMMAND_SECTIONS.flatMap((section) => section.rows.map((row) => row.command)),
  ]);
  const helpText = formatInteractiveCommandSections({ includeHidden: true }).join('\n');
  const catalogRows = INTERACTIVE_COMMAND_SECTIONS.flatMap((s) => s.rows);
  for (const cmd of [...folded, ...tuiOnly]) {
    assert.ok(!tokens.has(cmd), `shell-only command "${cmd}" is not in the REPL menu/completion`);
    assert.ok(!helpText.includes(cmd), `shell-only command "${cmd}" is not in REPL help text`);
  }
  for (const cmd of folded) {
    assert.ok(
      !catalogRows.some((r) => r.command === cmd),
      `folded command "${cmd}" is gone from the catalog`
    );
  }
  for (const cmd of tuiOnly) {
    const row = catalogRows.find((r) => r.command === cmd);
    assert.ok(row, `tui-only command "${cmd}" exists in the shared catalog`);
    assert.deepEqual(row.surfaces, ['tui'], `"${cmd}" is marked tui-only`);
  }
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
  for (const name of ['/loop', '/goal', '/init']) {
    assert.ok(
      !SHELL_COMMANDS.some((entry) => entry.command === name),
      `${name} stays REPL-only in the TUI projection`
    );
  }
  // D5 merges: the task-artifact family folds into /task view, bg+subs into
  // /jobs; the merged-away tokens stay dispatchable but leave the catalog.
  const tuiCommands = SHELL_COMMANDS.map((entry) => entry.command);
  for (const merged of [
    '/tasks',
    '/history',
    '/evidence',
    '/deployments',
    '/failures',
    '/bg',
    '/subs',
  ]) {
    assert.ok(!tuiCommands.includes(merged), `${merged} is no longer advertised (folded away)`);
  }
  assert.ok(
    !tuiCommands.includes('/jobs'),
    '/jobs stays dispatchable but leaves the everyday menu'
  );
  assert.ok(tuiCommands.includes('/task'), '/task stays advertised');
  assert.ok(tuiCommands.includes('/permissions'), '/permissions stays advertised');
  const taskRow = byCommand.get('/task');
  assert.ok(taskRow?.args?.includes('view'), '/task advertises the view subcommand');
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
