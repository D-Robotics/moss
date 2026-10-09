#!/usr/bin/env node
/**
 * P0-2: /plan enters plan mode. With a description it starts that plan.
 * On main, /plan with no arguments only printed the /mode help.
 */
import assert from 'node:assert/strict';

import { findRegistryCommand } from '../dist/cli/commands/registry.js';
import { getCliInteractionMode, setCliInteractionMode } from '../dist/cli/interaction-mode.js';

const match = findRegistryCommand('/plan');
assert.ok(match, '/plan is its own command');
assert.equal(match.spec.name, '/plan');
assert.equal(
  findRegistryCommand('/mode')?.spec.name,
  '/mode',
  '/mode is no longer how /plan is spelled'
);

setCliInteractionMode('full');
try {
  const said = [];
  let submitted = null;
  const ctx = {
    agent: {},
    runtime: undefined,
    sessionKey: 'plan-spec',
    workspace: process.cwd(),
    surface: 'repl',
    say(_kind, text) {
      said.push(text);
    },
    prefillInput() {},
    setInteractionMode(mode) {
      said.push(`mode:${mode}`);
    },
    submitPrompt(text) {
      submitted = text;
    },
  };
  await match.spec.run(ctx, '');
  assert.equal(getCliInteractionMode(), 'plan', '/plan with no description enters plan mode');
  assert.ok(
    said.some((line) => /Plan mode/i.test(line) && /Shift\+Tab/.test(line)),
    'the reply names plan mode and how to leave it'
  );
  assert.equal(submitted, null, 'no description does not start a run');

  await match.spec.run(ctx, 'sketch the parser');
  assert.equal(getCliInteractionMode(), 'plan');
  assert.equal(submitted, 'sketch the parser', '/plan <description> submits that description');
} finally {
  setCliInteractionMode('full');
}

console.log('[PASS] cli plan command');
