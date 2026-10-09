#!/usr/bin/env node
/**
 * P0-4 /loop migration, P0-8 retired job names, P1-1 silent aliases.
 * Aliases resolve to the canonical command; /help --all lists them.
 */
import assert from 'node:assert/strict';

import { findRegistryCommand } from '../dist/cli/commands/registry.js';
import {
  availabilityFor,
  isExactSlashCommand,
  rewriteSlashInput,
  slashAliasHelpLines,
} from '../dist/cli/interactive-commands.js';
import { buildHelpOverlayLines } from '../dist/cli/tui/app.js';

{
  assert.equal(isExactSlashCommand('/mode'), true, '/mode still dispatches when typed in full');
  assert.equal(isExactSlashCommand('/loop'), true, 'retired /loop still dispatches when typed');
  assert.equal(isExactSlashCommand('/mo'), false, 'a prefix is not an exact command');
  assert.equal(isExactSlashCommand('hello'), false);
}

{
  const loop = rewriteSlashInput('/loop make the suite pass');
  assert.match(loop.migration ?? '', /\/loop 已改为 \/goal/);
  assert.equal(loop.text, '/goal make the suite pass');
}

{
  for (const [from, to, migration] of [
    ['/jobs', '/tasks', '/jobs is now /tasks.'],
    ['/bg', '/tasks', '/bg is now /tasks.'],
    ['/subs extra', '/tasks extra', '/subs is now /tasks.'],
    ['/history', '/task view history', '/history is now /task view history.'],
    ['/evidence', '/task view evidence', '/evidence is now /task view evidence.'],
    ['/sessions mine', '/resume mine', '/sessions is now /resume.'],
  ]) {
    const rewritten = rewriteSlashInput(from);
    assert.equal(rewritten.text, to, from);
    assert.equal(rewritten.migration, migration, from);
  }
}

{
  assert.equal(rewriteSlashInput('/cost').text, '/usage');
  assert.equal(rewriteSlashInput('/stats').text, '/usage');
  assert.equal(findRegistryCommand('/cost')?.spec.name, '/usage');
  assert.equal(findRegistryCommand('/stats')?.spec.name, '/usage');
  assert.equal(findRegistryCommand('/usage')?.spec, findRegistryCommand('/cost')?.spec);
  assert.equal(rewriteSlashInput('/new').text, '/clear');
  assert.equal(rewriteSlashInput('/reset').text, '/clear');
  assert.equal(rewriteSlashInput('/checkpoint 4').text, '/rewind 4');
  assert.equal(rewriteSlashInput('/undo').text, '/rewind');
  assert.equal(rewriteSlashInput('/bashes').text, '/tasks');
  assert.equal(rewriteSlashInput('/ps').text, '/tasks');
  assert.equal(rewriteSlashInput('/exit').text, '/quit');
  const mode = rewriteSlashInput('/mode plan');
  assert.equal(mode.text, '/mode plan');
  assert.match(mode.migration ?? '', /Shift\+Tab/);
}

{
  const lines = slashAliasHelpLines().join('\n');
  assert.match(lines, /\/cost\s+alias of \/usage/);
  assert.match(lines, /\/new\s+alias of \/clear/);
  assert.match(lines, /\/ps\s+alias of \/tasks/);
  assert.match(lines, /\/loop 已改为 \/goal/);
  const help = buildHelpOverlayLines(true).join('\n');
  assert.match(help, /alias of \/usage/);
  assert.match(help, /\/checkpoint/);
}

{
  assert.equal(availabilityFor('/clear'), 'reject');
  assert.equal(availabilityFor('/new'), 'reject');
  assert.equal(availabilityFor('/plan sketch'), 'reject');
  assert.equal(availabilityFor('/init'), 'reject');
  assert.equal(availabilityFor('/review'), 'reject');
  assert.equal(availabilityFor('/compact'), 'reject');
  assert.equal(availabilityFor('/status'), 'immediate');
  assert.equal(availabilityFor('/tasks'), 'immediate');
  assert.equal(availabilityFor('/ps'), 'immediate');
  assert.equal(availabilityFor('/stop'), 'immediate');
  assert.equal(availabilityFor('/goal ship it'), 'queue');
  assert.equal(availabilityFor('/resume'), 'queue');
}

console.log('[PASS] cli slash aliases');
