#!/usr/bin/env node
/**
 * Shell key registry (plan v3 P4): Ctrl-letter actions come from one table, the
 * help block is generated from that table, and ~/.config/moss/keybindings.json
 * can rebind them with validation warnings instead of silent failures.
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_KEYBINDINGS,
  commandForKey,
  keyForCommand,
  loadKeybindings,
  shortcutRows,
} from '../dist/cli/tui/keymap.js';

// Defaults reproduce today's bindings exactly.
assert.equal(commandForKey(DEFAULT_KEYBINDINGS, 'ctrl+r'), 'history.search');
assert.equal(commandForKey(DEFAULT_KEYBINDINGS, 'ctrl+o'), 'view.toggleVerbose');
assert.equal(commandForKey(DEFAULT_KEYBINDINGS, 'ctrl+l'), 'composer.clear');
assert.equal(keyForCommand(DEFAULT_KEYBINDINGS, 'editor.external'), 'ctrl+g');

// No file: defaults, no warnings.
{
  const loaded = loadKeybindings(undefined);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(commandForKey(loaded.bindings, 'ctrl+r'), 'history.search');
}

// A valid override moves a command; the old key is free.
{
  const loaded = loadKeybindings(JSON.stringify({ 'history.search': 'ctrl+t' }));
  assert.deepEqual(loaded.warnings, []);
  assert.equal(commandForKey(loaded.bindings, 'ctrl+t'), 'history.search');
  assert.equal(commandForKey(loaded.bindings, 'ctrl+r'), undefined, 'the old key is unbound');
  assert.equal(keyForCommand(loaded.bindings, 'history.search'), 'ctrl+t');
}

// Validation: every problem is a warning, and the rest of the file still applies.
{
  const loaded = loadKeybindings(
    JSON.stringify({
      'no.such.command': 'ctrl+t',
      'view.toggleVerbose': 'ctrl+5',
      'run.interrupt': 'ctrl+z',
      'composer.clear': 'ctrl+r',
      'editor.external': 'ctrl+j',
    })
  );
  assert.ok(loaded.warnings.some((w) => w.includes('unknown command "no.such.command"')));
  assert.ok(
    loaded.warnings.some((w) => w.includes('"ctrl+5"')),
    'an unparseable key is reported'
  );
  assert.ok(
    loaded.warnings.some((w) => w.includes('run.interrupt') && w.includes('cannot be rebound')),
    'interrupt is locked'
  );
  assert.ok(
    loaded.warnings.some((w) => w.includes('ctrl+r') && w.includes('both')),
    'two commands on one key are reported'
  );
  assert.equal(
    commandForKey(loaded.bindings, 'ctrl+r'),
    'history.search',
    'table order keeps the first'
  );
  assert.equal(
    commandForKey(loaded.bindings, 'ctrl+j'),
    'editor.external',
    'valid rebinds still apply'
  );
  assert.equal(commandForKey(loaded.bindings, 'ctrl+c'), 'run.interrupt', 'the lock held');
}

// Malformed JSON keeps the defaults and says so.
{
  const loaded = loadKeybindings('{ not json');
  assert.equal(commandForKey(loaded.bindings, 'ctrl+r'), 'history.search');
  assert.ok(loaded.warnings.some((w) => w.includes('not valid JSON')));
}

// Help is generated from the same table, so an override shows up in it.
{
  const rows = shortcutRows(
    loadKeybindings(JSON.stringify({ 'history.search': 'ctrl+t' })).bindings
  );
  const search = rows.find((row) => row.label.includes('search your earlier prompts'));
  assert.equal(search?.keys, 'Ctrl+T');
  assert.ok(!rows.some((row) => row.keys === 'Ctrl+R' && row.label.includes('search')));
}
console.log('[PASS] TUI key registry (defaults, overrides, validation, generated help)');
