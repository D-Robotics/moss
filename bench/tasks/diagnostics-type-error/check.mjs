#!/usr/bin/env node
// Post-condition: `tsc --noEmit` on the workspace is clean, and tsconfig.json is
// untouched. The workspace carries a symlink to the repo's typescript install,
// so this runs offline with the pod's Node (no npx download).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Locate the repo's TypeScript without hard-coding the checkout: the bench
// runner sets MOSS_BENCH_TASK_DIR to this task directory (inside the repo).
const taskDir = process.env.MOSS_BENCH_TASK_DIR;
const repoRoot = taskDir ? path.resolve(taskDir, '../../..') : process.cwd();
const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', '.'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 120_000,
});
assert.equal(run.status, 0, `tsc still fails:\n${run.stdout ?? ''}\n${run.stderr ?? ''}`);
const math = readFileSync(path.join(process.cwd(), 'src/math.ts'), 'utf8');
assert.ok(math.includes('a + b'), 'add() must still compute the numeric sum');
const tsconfig = readFileSync(path.join(process.cwd(), 'tsconfig.json'), 'utf8');
assert.ok(tsconfig.includes('"strict": true'), 'tsconfig.json must stay strict');
console.log('check passed');
