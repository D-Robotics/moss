#!/usr/bin/env node
/**
 * `moss loop --watch` probe (offline).
 *
 * A loop could only retry on a fixed clock (`--every`); the external-signal gap
 * (a CI artifact lands, a build finishes elsewhere) had no trigger. `--watch`
 * waits for the path's signature to change before the next attempt, and gives
 * up after `--watch-timeout` with reason `watch_timeout` instead of burning the
 * remaining attempts. Real runs are proven separately; this locks the parser,
 * the signature diff, and the timeout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const {
  parseLoopArgs,
  watchSignature,
  waitForWatchChange,
  renderLoopRunRows,
  formatLoopRunDetail,
} = await load('dist/cli/loop-command.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-watch] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loopwatch-'));
const file = path.join(tmp, 'signal.txt');
const dir = path.join(tmp, 'dist');
const missing = path.join(tmp, 'not-yet');

const defaults = parseLoopArgs(['--until', 'true', 'a goal']);
assert.equal(defaults.watch, undefined);
assert.equal(defaults.watchTimeoutMs, 10 * 60_000);
const parsed = parseLoopArgs([
  '--until',
  'true',
  '--watch',
  file,
  '--watch-timeout',
  '2s',
  'a goal',
]);
assert.equal(parsed.watch, file);
assert.equal(parsed.watchTimeoutMs, 2_000);
const fromEq = parseLoopArgs(['--until=true', `--watch=${file}`, '--watch-timeout=30s', 'goal']);
assert.equal(fromEq.watch, file);
assert.equal(fromEq.watchTimeoutMs, 30_000);
assert.throws(() => parseLoopArgs(['--watch', '', '--until', 'true', 'goal']));
assert.throws(() =>
  parseLoopArgs(['--watch', file, '--watch-timeout', '0', '--until', 'true', 'g'])
);
assert.throws(() => parseLoopArgs(['--until', 'true', '--watch-timeout', 'soon', 'goal']));
ok('parser: --watch/--watch-timeout (space and =), defaults, and bad values');

await fs.writeFile(file, 'first\n');
const before = await watchSignature(file);
await fs.writeFile(file, 'second\n');
const after = await watchSignature(file);
assert.notEqual(before.signature, after.signature);
assert.equal(before.exists, true);
ok('a file rewrite changes the signature (size or mtime)');

await fs.mkdir(dir);
await fs.writeFile(path.join(dir, 'artifact.tar'), 'x');
const dirBefore = await watchSignature(dir);
await fs.writeFile(path.join(dir, 'artifact.tar'), 'y'.repeat(20));
const dirAfter = await watchSignature(dir);
assert.notEqual(dirBefore.signature, dirAfter.signature);
assert.match(dirAfter.signature, /artifact\.tar/);
ok('a directory tree signature tracks child size/mtime');

const missingState = await watchSignature(missing);
assert.equal(missingState.exists, false);
assert.equal(missingState.signature, 'missing:');
ok('a missing path has a distinct signature (creation counts as a change)');

const timedOut = await waitForWatchChange(missing, { timeoutMs: 120, pollMs: 30 });
assert.equal(timedOut.changed, false);
assert.equal(timedOut.before.exists, false);
assert.ok(timedOut.waitedMs >= 120);
ok('an unchanged path times out with the elapsed wall clock');

const wake = waitForWatchChange(missing, { timeoutMs: 5_000, pollMs: 25 });
setTimeout(() => {
  fs.writeFile(missing, 'wake\n').catch(() => {});
}, 60);
const woken = await wake;
assert.equal(woken.changed, true);
assert.equal(woken.before.exists, false);
assert.equal(woken.after.exists, true);
assert.ok(woken.waitedMs < 5_000, 'resolves as soon as the signal appears');
ok('waitForWatchChange resolves when the watched path appears');

const rows = renderLoopRunRows(
  [
    {
      runId: 'loop-watch-timeout',
      ledger: '.moss/loops/loop-watch-timeout.jsonl',
      passed: false,
      reason: 'watch_timeout',
      attempts: 1,
      maxAttempts: 3,
      totalDurationMs: 8_000,
      until: 'test -f ci/artifact.tar',
      interrupted: false,
    },
  ],
  { limit: 5 }
);
assert.match(rows.join('\n'), /watch timed out|外部信号等待超时/);
ok('the run table names the watch timeout as its own reason');

const detail = formatLoopRunDetail(
  {
    runId: 'loop-woke',
    ledger: '.moss/loops/loop-woke.jsonl',
    passed: true,
    reason: 'passed',
    attempts: 2,
    maxAttempts: 3,
    totalDurationMs: 26_630,
    until: 'test -f external.txt',
    watch: 'external.txt',
    interrupted: false,
  },
  {
    attempts: [
      {
        type: 'attempt',
        runId: 'loop-woke',
        attempt: 2,
        at: new Date().toISOString(),
        durationMs: 4_893,
        sessionKey: 'loop-woke-attempt-2',
        check: { exitCode: 0, durationMs: 5, stdout: '', stderr: '' },
        passed: true,
        waitedMs: 20_046,
      },
    ],
    summary: {
      type: 'summary',
      runId: 'loop-woke',
      at: new Date().toISOString(),
      passed: true,
      attempts: 2,
      maxAttempts: 3,
      maxDurationMs: 0,
      totalDurationMs: 26_630,
      reason: 'passed',
      until: 'test -f external.txt',
      watch: 'external.txt',
    },
    torn: 0,
  }
);
assert.match(detail.join('\n'), /WATCH\s+external\.txt/);
assert.match(detail.join('\n'), /wait 20\.0s/);
ok('`loop show` prints the watched path and the pre-attempt wait');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[loop-watch] ${checks}/8 checks passed`);
