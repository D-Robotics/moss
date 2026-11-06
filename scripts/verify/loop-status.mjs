#!/usr/bin/env node
/**
 * `moss loop list` in-flight status probe (offline).
 *
 * B100 labelled every run without a summary as `interrupted`, which conflated
 * "still running" with "killed". For unattended runs that is the difference
 * between leaving it alone and restarting it. The loop now writes a `start`
 * record with its pid; the history read checks liveness (same host) and reports
 * `running` vs `interrupted`, plus the pid for `loop show` / `--json`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { listLoopRuns, isLoopProcessAlive, renderLoopRunRows, formatLoopRunDetail } = await load(
  'dist/cli/loop-command.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-status] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loopstatus-'));
const ws = path.join(tmp, 'ws');
const loops = path.join(ws, '.moss', 'loops');
await fs.mkdir(loops, { recursive: true });

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const attempt = (runId, at) => ({
  type: 'attempt',
  runId,
  attempt: 1,
  at,
  durationMs: 3_000,
  sessionKey: `${runId}-attempt-1`,
  check: { exitCode: 1, durationMs: 40, stdout: 'not yet', stderr: '' },
  passed: false,
});
const write = async (name, records, mtimeMs) => {
  const file = path.join(loops, name);
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
};

// A loop that is running right now: this probe process stands in for it.
await write(
  'loop-live.jsonl',
  [
    {
      type: 'start',
      runId: 'loop-live',
      at: iso(-6_000),
      pid: process.pid,
      until: 'test -f never.txt',
      maxAttempts: 3,
      prompt: 'reply waiting',
    },
    attempt('loop-live', iso(-5_000)),
  ],
  now
);
// A killed/crashed loop: the pid is gone and no summary was written.
await write(
  'loop-dead.jsonl',
  [
    {
      type: 'start',
      runId: 'loop-dead',
      at: iso(-60_000),
      pid: 2_147_483_646,
      until: 'test -f gone.txt',
      maxAttempts: 2,
      prompt: 'reply waiting',
    },
    attempt('loop-dead', iso(-59_000)),
  ],
  now - 30_000
);
// A ledger from before start records existed: attempts only, no pid.
await write('loop-legacy.jsonl', [attempt('loop-legacy', iso(-120_000))], now - 100_000);

assert.equal(isLoopProcessAlive(process.pid), true);
assert.equal(isLoopProcessAlive(2_147_483_646), false);
assert.equal(isLoopProcessAlive(undefined), false);
assert.equal(isLoopProcessAlive(0), false);
ok('liveness: current pid alive, impossible/absent pid dead');

const runs = listLoopRuns(ws);
const byId = new Map(runs.map((run) => [run.runId, run]));
assert.equal(byId.get('loop-live')?.status, 'running');
assert.equal(byId.get('loop-live')?.pid, process.pid);
assert.equal(byId.get('loop-live')?.maxAttempts, 3, 'maxAttempts falls back to the start record');
assert.equal(byId.get('loop-dead')?.status, 'interrupted');
assert.equal(byId.get('loop-legacy')?.status, 'interrupted');
ok('listLoopRuns: running (live pid) vs interrupted (dead pid / legacy ledger)');

const rows = renderLoopRunRows(runs, { limit: 10 }).join('\n');
assert.match(rows, /running/);
assert.match(rows, new RegExp(`in progress \\(pid ${String(process.pid)}\\)`));
assert.match(rows, /interrupted/);
assert.match(rows, /no summary and the process is gone/);
ok('the table distinguishes in-flight runs from dead ones');

const live = byId.get('loop-live');
const detail = formatLoopRunDetail(live, {
  attempts: [attempt('loop-live', iso(-5_000))],
  start: {
    type: 'start',
    runId: 'loop-live',
    at: iso(-6_000),
    pid: process.pid,
    until: 'test -f never.txt',
    maxAttempts: 3,
    prompt: 'reply waiting',
  },
  torn: 0,
});
assert.match(detail.join('\n'), new RegExp(`PID\\s+${String(process.pid)}`));
assert.match(detail.join('\n'), /RESULT\s+running \(no summary yet\)/);
ok('`loop show` prints the pid only while the run is in progress');

const dead = byId.get('loop-dead');
const deadDetail = formatLoopRunDetail(dead, {
  attempts: [attempt('loop-dead', iso(-59_000))],
  start: {
    type: 'start',
    runId: 'loop-dead',
    at: iso(-60_000),
    pid: 2_147_483_646,
    until: 'test -f gone.txt',
    maxAttempts: 2,
    prompt: 'reply waiting',
  },
  torn: 0,
});
assert.match(deadDetail.join('\n'), /RESULT\s+interrupted \(no summary and the process is gone\)/);
assert.doesNotMatch(
  deadDetail.join('\n'),
  /^PID\s/m,
  'an interrupted run must not show a stale pid'
);
ok('`loop show` says the dead run is interrupted and shows no stale pid');

// The JSON view carries the same fields for scripts.
const parsed = JSON.parse(JSON.stringify(listLoopRuns(ws)));
assert.equal(parsed.find((run) => run.runId === 'loop-live').status, 'running');
assert.equal(parsed.find((run) => run.runId === 'loop-live').pid, process.pid);
ok('`--json` rows carry status + pid');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[loop-status] ${checks}/6 checks passed`);
