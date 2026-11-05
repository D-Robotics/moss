#!/usr/bin/env node
/**
 * Deterministic probe for `moss loop --until` (acceptance-loop P2-a).
 *
 * Model-free: `--mock` keeps the agent turns offline, and the check command is a
 * local script whose exit code we control, so the loop contract (retry on
 * failure, pass only on the check's exit 0, bounded attempts, usage errors) is
 * asserted without a provider.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist/cli.js');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loop-probe-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loop-home-'));

const baseEnv = {
  ...process.env,
  HOME: home,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_NO_TUI: '1',
};

function run(args) {
  return captureProcess(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: baseEnv,
    timeoutMs: 120_000,
  });
}

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[loop] ok ${name}`);
}

// 1. A failing check retries and the loop passes on the second attempt.
await fs.rm(path.join(workspace, 'flag'), { force: true });
const retry = await run([
  'loop',
  '--mock',
  '--until',
  'if [ -f flag ]; then exit 0; else touch flag; exit 1; fi',
  'just say hello',
]);
assert.equal(retry.status, 0, retry.stderr);
assert.match(retry.stdout, /after attempt 2/);
assert.ok(await fs.stat(path.join(workspace, 'flag')));
ok('a failing check triggers a second attempt and exits 0 when it passes');

// 2. Exhausting --max keeps the failure: exit 1 with the check output tail.
const exhausted = await run([
  'loop',
  '--mock',
  '--max',
  '2',
  '--until',
  'echo boom >&2; exit 7',
  'just say hello',
]);
assert.equal(exhausted.status, 1);
assert.match(exhausted.stdout, /still exited 7 after 2 attempts/);
assert.match(exhausted.stdout, /boom/);
ok('exhausted attempts exit 1 and show the check output');

// 3. --until is mandatory: no command means no verdict.
const missing = await run(['loop', '--mock', 'just say hello']);
assert.equal(missing.status, 2);
assert.match(missing.stderr, /--until is required/);
ok('a loop without --until is a usage error (exit 2)');

// 4. Help is a real page, not a prompt.
const help = await run(['loop', '--help']);
assert.equal(help.status, 0);
assert.match(help.stdout, /moss loop --until/);
ok('moss loop --help renders usage');

// 5. The loop survives an agent that ends with an error, because the check
//    command stays the only judge.
const survivor = await run(['loop', '--mock', '--max', '1', '--until', 'exit 0', 'anything']);
assert.equal(survivor.status, 0);
ok('the check command, not the agent prose, decides the exit code');

// 6. D13: --every parses durations and paces failed attempts.
const loopModule = await import(pathToFileURL(path.join(root, 'dist/cli/loop-command.js')).href);
assert.equal(loopModule.parseLoopDuration('250ms'), 250);
assert.equal(loopModule.parseLoopDuration('30s'), 30_000);
assert.equal(loopModule.parseLoopDuration('5m'), 300_000);
assert.equal(loopModule.parseLoopDuration('1h'), 3_600_000);
assert.equal(loopModule.parseLoopArgs(['--until', 'true', '--every', '2s', 'hello']).everyMs, 2000);
for (const bad of ['0.5x', 'x', '25h', '-1s']) {
  assert.throws(() => loopModule.parseLoopDuration(bad), /--every/);
}
ok('--every accepts ms/s/m/h and rejects malformed durations');

const paced = await run([
  'loop',
  '--mock',
  '--every',
  '150ms',
  '--max',
  '2',
  '--until',
  'exit 1',
  'just say hello',
]);
assert.equal(paced.status, 1);
assert.match(paced.stderr, /waiting 150ms before attempt 2/);
assert.ok(paced.durationMs >= 150, `expected the loop to wait, ran ${paced.durationMs}ms`);
ok('--every really waits between failed attempts');

await fs.rm(workspace, { recursive: true, force: true });
await fs.rm(home, { recursive: true, force: true });
console.log(`[loop] PASS (${checks} checks)`);
