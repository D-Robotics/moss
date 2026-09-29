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
  for (const cmd of [
    '/help',
    '/model',
    '/sessions',
    '/status',
    '/compact',
    '/loop',
    '/usage',
    '/review',
  ]) {
    assert.ok(hasCmd(cmd), `critical command "${cmd}" is visible in the catalog`);
  }
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
  assert.ok(joined.includes('/sessions'), 'formatted commands include /sessions');
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
  for (const cmd of ['/help', '/model', '/sessions', '/compact', '/quit']) {
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

// ─── Commands without handlers are never advertised ──────────────────────────

{
  // /steer /queue /history /resume /clear were advertised in v0.13 without any
  // REPL handler. They must stay out of the catalog, completion, and help text
  // until their real implementations land (resume replay v0.17, TUI v0.18).
  const dead = ['/steer', '/queue', '/history', '/resume', '/clear'];
  const tokens = new Set([
    ...SLASH_MENU_ROWS.map((row) => row.command),
    ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
    ...INTERACTIVE_COMPLETION_COMMANDS,
    ...INTERACTIVE_COMMAND_SECTIONS.flatMap((section) =>
      section.rows.map((row) => row.command.split(/\s+/, 1)[0])
    ),
  ]);
  const helpText = formatInteractiveCommandSections({ includeHidden: true }).join('\n');
  for (const cmd of dead) {
    assert.ok(!tokens.has(cmd), `dead command "${cmd}" is not in the menu/completion`);
    assert.ok(!helpText.includes(cmd), `dead command "${cmd}" is not in help text`);
  }
}

console.log('[PASS] Interactive slash commands');
