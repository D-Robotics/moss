#!/usr/bin/env node
/**
 * The PTY layout specs must not pass when pyte is missing.
 * MOSS_SKIP_PY_LAYOUT=1 is the only skip.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTE_INSTALL, pyteMissingMessage } from './helpers/require-pyte.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = [
  'tui-screen-layout.spec.mjs',
  'tui-mcp-failure-layout.spec.mjs',
  'tui-inline-exit.spec.mjs',
];

assert.match(
  pyteMissingMessage('tui-screen-layout'),
  new RegExp(PYTE_INSTALL.replace(/ /g, '\\s+'))
);
assert.match(pyteMissingMessage('tui-mcp-failure-layout'), /MOSS_SKIP_PY_LAYOUT=1/);

function runSpec(name, env) {
  const childEnv = { ...process.env, PATH: path.dirname(process.execPath) };
  delete childEnv.MOSS_SKIP_PY_LAYOUT;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [path.join(root, 'test', name)], {
    encoding: 'utf8',
    env: childEnv,
  });
}

for (const name of specs) {
  const missing = runSpec(name, {});
  const output = `${missing.stdout ?? ''}${missing.stderr ?? ''}`;
  assert.notEqual(missing.status, 0, `${name} must fail when pyte cannot be imported`);
  assert.match(output, /python3 -m pip install pyte/, `${name} names the install command`);
  assert.match(output, /MOSS_SKIP_PY_LAYOUT=1/, `${name} names the skip switch`);

  const skipped = runSpec(name, { MOSS_SKIP_PY_LAYOUT: '1' });
  const skipOut = `${skipped.stdout ?? ''}${skipped.stderr ?? ''}`;
  assert.equal(skipped.status, 0, `${name} honors MOSS_SKIP_PY_LAYOUT=1`);
  assert.match(skipOut, /MOSS_SKIP_PY_LAYOUT=1/);
}

console.log('[PASS] layout specs fail without pyte unless MOSS_SKIP_PY_LAYOUT=1');
