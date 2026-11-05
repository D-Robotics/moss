#!/usr/bin/env node
/**
 * `moss loop follow` probe (offline).
 *
 * B103 made `loop list` honest about whether a run is alive, but watching an
 * unattended run still meant polling `list`/`show` yourself. Cursor shows the
 * run progressing. `follow` polls the ledger (no IPC, no agent) and streams
 * attempts and the summary; existing attempts are printed by the caller as the
 * header, only later appends are events. This locks selection, streaming,
 * termination and the not-found paths.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { followLoopRun, listLoopRuns, formatLoopAttemptLine } = await load(
  'dist/cli/loop-command.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-follow] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loopfollow-'));
const ws = path.join(tmp, 'ws');
const loops = path.join(ws, '.moss', 'loops');
await fs.mkdir(loops, { recursive: true });

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const startRecord = (runId, pid) => ({
  type: 'start',
  runId,
  at: iso(-10_000),
  pid,
  until: 'test -f done.txt',
  maxAttempts: 3,
  prompt: 'work',
});
const attemptRecord = (runId, attempt, passed, at) => ({
  type: 'attempt',
  runId,
  attempt,
  at,
  durationMs: 2_000,
  sessionKey: `${runId}-${String(attempt)}`,
  check: {
    exitCode: passed ? 0 : 1,
    durationMs: 10,
    stdout: passed ? 'ok' : 'missing done.txt',
    stderr: '',
  },
  passed,
});
const summaryRecord = (runId, passed, attempts) => ({
  type: 'summary',
  runId,
  at: iso(-1_000),
  passed,
  attempts,
  maxAttempts: 3,
  maxDurationMs: 0,
  totalDurationMs: 9_000,
  reason: passed ? 'passed' : 'attempts_exhausted',
  until: 'test -f done.txt',
});
const append = (file, record) => fs.appendFile(file, `${JSON.stringify(record)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- live run: one attempt already there, a second + summary arrive later ---
const liveFile = path.join(loops, 'loop-live.jsonl');
await fs.writeFile(
  liveFile,
  [startRecord('loop-live', process.pid), attemptRecord('loop-live', 1, false, iso(-9_000))]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n'
);
const events = [];
let started;
const following = followLoopRun(ws, {
  pollMs: 60,
  onStart: (run, attempts) => {
    started = { runId: run.runId, attempts: attempts.length, status: run.status };
  },
  onEvent: (event) => events.push(event),
});
await sleep(180);
await append(liveFile, attemptRecord('loop-live', 2, true, iso(-5_000)));
await sleep(180);
await append(liveFile, summaryRecord('loop-live', true, 2));
const live = await following;
assert.ok(started, 'onStart runs with the already-recorded state');
assert.equal(started.runId, 'loop-live');
assert.equal(started.attempts, 1);
assert.equal(started.status, 'running');
assert.equal(live.status, 'passed');
assert.equal(live.attempts.length, 2);
assert.equal(live.summary?.passed, true);
assert.deepEqual(
  events.map((event) => event.kind),
  ['attempt', 'summary'],
  'only appends after start are streamed as events'
);
assert.equal(events[0].attempt.attempt, 2);
assert.match(formatLoopAttemptLine(events[0].attempt), /#2 .*check exit 0 .*PASS/);
ok('follows a live run: existing state as header, then new attempt and summary');

// --- already finished: returns immediately, no polling forever -------------
const finished = await followLoopRun(ws, { runId: 'loop-live', pollMs: 60 });
assert.equal(finished.status, 'passed');
assert.equal(finished.summary?.reason, 'passed');
ok('a finished run returns immediately with its summary');

// --- killed run: start pid is gone and no summary exists -------------------
const deadFile = path.join(loops, 'loop-dead.jsonl');
await fs.writeFile(
  deadFile,
  [startRecord('loop-dead', 2_147_483_646), attemptRecord('loop-dead', 1, false, iso(-8_000))]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n'
);
const dead = await followLoopRun(ws, { runId: 'loop-dead', pollMs: 60 });
assert.equal(dead.status, 'interrupted');
assert.equal(dead.summary, undefined);
ok('a killed run reports interrupted instead of waiting forever');

// --- selection + unknown ids ----------------------------------------------
const auto = await followLoopRun(ws, { pollMs: 60 });
assert.equal(auto.runId, listLoopRuns(ws)[0].runId, 'default follows the newest run');
assert.equal(await followLoopRun(ws, { runId: 'no-such-run', pollMs: 60 }), undefined);
const emptyWs = path.join(tmp, 'empty');
assert.equal(await followLoopRun(emptyWs, { pollMs: 60 }), undefined);
ok('defaults to newest, unknown ids and empty workspaces resolve to undefined');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[loop-follow] ${checks}/4 checks passed`);
