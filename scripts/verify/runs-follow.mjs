#!/usr/bin/env node
/**
 * `moss runs follow` probe (offline, B183).
 *
 * The ledger already records running rows (B178–B181); follow is the read side
 * that watches them settle. The diff/format helpers are pure, and the CLI paths
 * (empty ledger timeout, bad flags, --json baseline) are exercised for real.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { followDiff, formatFollowEvent, parseFollowDuration } =
  await load('dist/cli/runs-follow.js');
const { writeRunRecord } = await load('dist/core/run-ledger.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[runs-follow] ok ${name}`);
};

// 1. Duration parsing.
assert.equal(parseFollowDuration('500ms'), 500);
assert.equal(parseFollowDuration('1s'), 1_000);
assert.equal(parseFollowDuration('5m'), 300_000);
assert.equal(parseFollowDuration('2 h'), 7_200_000);
for (const bad of ['0s', '-1s', 's', '1.5s', '10d', '']) {
  assert.equal(parseFollowDuration(bad), undefined, `${bad} is invalid`);
}
ok('follow durations accept ms/s/m/h and reject everything else');

// 2. Diff semantics: new, changed, unchanged, newest first.
const record = (runId, status, endedAt, goal = runId) => ({
  version: 1,
  runId,
  kind: 'loop',
  status,
  exitCode: 0,
  startedAt: endedAt - 1_000,
  endedAt,
  durationMs: 1_000,
  goal,
  artifacts: {},
});
const running = record('loop_a', 'running', 1_000);
const previous = new Map([['loop_a', running]]);
const done = record('loop_a', 'completed', 2_000);
const fresh = record('loop_b', 'running', 1_500);
const diff = followDiff(previous, [done, fresh]);
assert.deepEqual(
  diff.events.map((event) => `${event.type}:${event.record.runId}`),
  ['update:loop_a', 'new:loop_b']
);
assert.equal(diff.next.size, 2);
assert.deepEqual(followDiff(previous, [running]).events, [], 'no change, no event');
assert.match(
  formatFollowEvent({ type: 'new', record: fresh }),
  /^\+ .* running loop loop_b — loop_b$/
);
assert.match(formatFollowEvent({ type: 'update', record: done }), /^~ .* completed loop loop_a/);
ok('diff reports new and changed runs (newest first) and stays quiet otherwise');

// 3. Real CLI paths.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-runs-follow-'));
const ws = path.join(tmp, 'ws');
const home = path.join(tmp, 'home');
await fs.mkdir(ws, { recursive: true });
const configDir = path.join(home, 'config');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(
  path.join(configDir, 'config.json'),
  JSON.stringify({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' }),
  'utf8'
);
const env = {
  ...process.env,
  HOME: home,
  MOSS_CONFIG_DIR: configDir,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_NO_TUI: '1',
  MOSS_LANG: 'en',
};
const cli = (args) =>
  captureProcess(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
    cwd: ws,
    env,
    timeoutMs: 30_000,
  });
const empty = await cli(['runs', 'follow', '--timeout', '600ms']);
assert.equal(empty.status, 1);
assert.match(empty.stderr, /no running run observed/);
assert.match(empty.stderr, /waiting for a new one/);
assert.equal((await cli(['runs', 'follow', '--timeout', 'soon'])).status, 2);
assert.equal((await cli(['runs', 'follow', '--kind', 'nope'])).status, 2);
// A live in-flight row is announced on the first poll, then the timeout exits 1.
await writeRunRecord(ws, {
  version: 1,
  runId: 'loop_live',
  kind: 'loop',
  status: 'running',
  exitCode: 0,
  startedAt: Date.now() - 1_000,
  endedAt: Date.now() - 1_000,
  durationMs: 0,
  goal: 'live loop',
  pid: process.pid,
  host: os.hostname(),
  artifacts: {},
});
const watched = await cli([
  'runs',
  'follow',
  '--interval',
  '200ms',
  '--timeout',
  '800ms',
  '--json',
]);
assert.equal(watched.status, 1);
const lines = watched.stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
assert.equal(lines.length, 1);
assert.equal(lines[0].type, 'new');
assert.equal(lines[0].record.runId, 'loop_live');
assert.equal(lines[0].record.status, 'running');
ok('the CLI announces an in-flight row, times out with exit 1 and validates flags');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[runs-follow] ${checks}/${checks} checks passed`);
