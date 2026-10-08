#!/usr/bin/env node
/**
 * A long run that edits JS/TS must be told it never verified. multi_edit
 * carries paths on edits[], not input.path — the old check missed that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { needsTestHint, noteToolForVerifyHint } from '../dist/cli/verify-hint.js';

function state() {
  return { editedJsTs: false, ranTests: false };
}

test('a single-file TS edit asks for tests', () => {
  const hint = state();
  noteToolForVerifyHint(hint, 'edit_file', { path: 'src/app.ts' });
  assert.equal(needsTestHint(hint), true);
});

test('multi_edit of TS files counts even without a top-level path', () => {
  const hint = state();
  noteToolForVerifyHint(hint, 'multi_edit', {
    edits: [{ path: 'src/a.ts' }, { path: 'README.md' }],
  });
  assert.equal(needsTestHint(hint), true);
});

test('a Python edit does not ask for the JS test runner', () => {
  const hint = state();
  noteToolForVerifyHint(hint, 'edit_file', { path: 'src/app.py' });
  assert.equal(needsTestHint(hint), false);
});

test('run_tests, diagnostics, or an exec test command silence the hint', () => {
  for (const call of [
    ['run_tests', {}],
    ['code_diagnostics', { path: 'src/app.ts' }],
    ['exec', { command: 'npm test' }],
  ]) {
    const hint = state();
    noteToolForVerifyHint(hint, 'edit_file', { path: 'src/app.ts' });
    noteToolForVerifyHint(hint, call[0], call[1]);
    assert.equal(needsTestHint(hint), false, call[0]);
  }
});
