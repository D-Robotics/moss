#!/usr/bin/env node
/**
 * Inline exit, through a real PTY and pyte: the answer stays on the primary
 * screen, the continue hint is printed, and the exit does not wipe the
 * display or leave the alternate screen.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';
import { requirePyLayout } from './helpers/require-pyte.mjs';

const root = path.resolve(import.meta.dirname, '..');
if (requirePyLayout('tui-inline-exit')) {
  const result = spawnSync('python3', [path.join(root, 'test', 'fixtures', 'tui-inline-exit.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45_000,
    env: isolatedCliEnv({ isolateHome: false }),
  });
  process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.status, 0, 'inline exit must keep the answer on the primary screen');
}
