#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const root = path.resolve(import.meta.dirname, '..');
const probe = spawnSync('python3', ['-c', 'import pyte'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[tui-mcp-failure-layout] skip: python3 or pyte is not available');
} else {
  const result = spawnSync(
    'python3',
    [path.join(root, 'test', 'fixtures', 'tui-mcp-failure-layout.py')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: isolatedCliEnv({ isolateHome: false }),
    }
  );
  process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.status, 0, 'MCP failure must preserve TUI layout invariants');
}
