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
import { commandList } from '../dist/cli/tui.js';

// ─── Command sections are organized and complete ──────────────────────────────

{
  const titles = INTERACTIVE_COMMAND_SECTIONS.map((s) => s.title);
  for (const expected of ['Work', 'Inspect', 'Configure', 'Control']) {
    assert.ok(titles.includes(expected), `section "${expected}" exists in the command catalog`);
  }
}

// ─── /help stays an overview instead of dumping every extension ─────────────

{
  const extensions = Array.from({ length: 80 }, (_, index) => ({
    name: `/extension-${index}`,
    summary: `Very long extension description ${index} that should not flood the main help screen`,
    run() {},
  }));
  const help = commandList(extensions);
  assert.ok(help.includes('/help'), 'overview keeps core commands');
  assert.ok(help.includes('80'), 'overview reports how many extensions are available');
  assert.ok(help.includes('Tab'), 'overview points to interactive discovery');
  assert.ok(!help.includes('Very long extension description 79'), 'overview does not dump every extension description');
  assert.ok(!help.includes('/compact [instructions]'), 'overview excludes hidden expert variants');
  assert.ok(help.split('\n').length <= 30, 'overview remains compact even with many extensions');
}

// ─── Critical commands are visible ───────────────────────────────────────────

{
  const allVisible = INTERACTIVE_COMMAND_SECTIONS.flatMap((s) => s.rows).filter((r) => !r.hidden).map((r) => r.command);
  // Commands may include argument descriptions in their names (e.g. "/connect <ip>")
  const hasCmd = (prefix) => allVisible.some((c) => c === prefix || c.startsWith(prefix + ' '));
  for (const cmd of ['/help', '/clear', '/model', '/sessions', '/status', '/goal', '/compact', '/steer', '/connect', '/review', '/soul']) {
    assert.ok(hasCmd(cmd), `critical command "${cmd}" is visible in the catalog`);
  }
  assert.ok(allVisible.includes('/btw stop'), 'BTW cancellation has a clear visible command entry');
}

// ─── formatInteractiveCommandSections — structured help text ─────────────────

{
  // Returns an array of strings (one per section line)
  const lines = formatInteractiveCommandSections({ locale: 'en', includeHidden: false });
  assert.ok(Array.isArray(lines), 'formatInteractiveCommandSections returns an array');
  const joined = lines.join('\n');
  assert.ok(joined.includes('/help'), 'formatted commands include /help');
  assert.ok(joined.includes('/clear'), 'formatted commands include /clear');
  assert.ok(joined.includes('/model'), 'formatted commands include /model');
  assert.ok(joined.includes('/sessions'), 'formatted commands include /sessions');
  assert.ok(joined.includes('/soul'), 'formatted commands include the Soul entry');
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
  assert.ok(rows.some(([cmd]) => cmd === '/model' || cmd.startsWith('/model')), 'typing "/mo" surfaces /model');
}

{
  const rows = commandRowsForSlashInput('/sou');
  assert.ok(rows.some(([cmd]) => cmd === '/soul'), 'typing "/sou" surfaces the Soul command');
}

{
  // Fuzzy matching handles small typos
  const rows = commandRowsForSlashInput('/cler');
  assert.ok(rows.some(([cmd]) => cmd === '/clear' || cmd.startsWith('/clear')), 'typo "/cler" still finds /clear');
}

{
  // Unknown prefix returns empty or minimal results, doesn't crash
  const rows = commandRowsForSlashInput('/zzz');
  assert.ok(Array.isArray(rows), 'unknown prefix returns array without crashing');
}

// ─── INTERACTIVE_COMPLETION_COMMANDS includes slash aliases ──────────────────

{
  for (const cmd of ['/help', '/clear', '/model', '/sessions', '/goal', '/compact', '/quit']) {
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

console.log('[PASS] Interactive slash commands');
