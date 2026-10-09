#!/usr/bin/env node
/**
 * `moss setup --help` is setup's own usage, and the model list count matches
 * the rows that are printed.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { formatDiscoveredModels, renderSetupHelp } from '../dist/cli/setup-wizard.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

{
  const help = renderSetupHelp();
  assert.match(help, /^Usage:\n {2}moss setup/);
  assert.match(help, /openai-compatible/);
  assert.match(help, /hidden prompt/);
  assert.match(help, /never printed/);
  assert.doesNotMatch(help, /Most useful/);
  assert.doesNotMatch(help, /sk-[A-Za-z0-9]{8,}/);
}

{
  const names = Array.from({ length: 17 }, (_, i) => `model-${i + 1}`);
  const listed = formatDiscoveredModels(names);
  assert.equal(listed.heading, 'Found 17 model(s):');
  assert.equal(listed.lines.length, 17);
  assert.equal(listed.choices.length, 17);
  assert.equal(listed.lines[0], '  1. model-1');
  assert.equal(listed.lines[16], '  17. model-17');
  assert.doesNotMatch(listed.heading, /showing/);
}

{
  const names = Array.from({ length: 32 }, (_, i) => `model-${i + 1}`);
  const listed = formatDiscoveredModels(names);
  assert.equal(listed.heading, 'Found 32 model(s), showing 30 of 32:');
  assert.equal(listed.lines.length, 30);
  assert.equal(listed.choices.length, 30);
  assert.equal(listed.choices[29], 'model-30');
}

{
  const listed = formatDiscoveredModels(['alpha', 'alpha', ' beta ', '']);
  assert.equal(listed.heading, 'Found 2 model(s):');
  assert.deepEqual(listed.choices, ['alpha', 'beta']);
  assert.equal(listed.lines.length, listed.choices.length);
}

function runSetupHelp(args) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

{
  const result = runSetupHelp(['setup', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moss setup/);
  assert.match(result.stdout, /openai-compatible/);
  assert.doesNotMatch(result.stdout, /Most useful/);
  assert.doesNotMatch(result.stdout, /最常用/);
  assert.equal(result.stdout.trim(), renderSetupHelp());
}

{
  const result = runSetupHelp(['setup', '-h']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hidden prompt/);
  assert.doesNotMatch(result.stdout, /start interactive Moss/);
}

{
  const generic = runSetupHelp(['--help']);
  assert.equal(generic.status, 0, generic.stderr);
  assert.match(generic.stdout, /Most useful|最常用/);
  assert.notEqual(generic.stdout.trim(), renderSetupHelp());
}

console.log('[PASS] setup help and model list');
