#!/usr/bin/env node
/**
 * Goal-run rollup probe (offline).
 *
 * `.moss/goals.jsonl` is the cross-run ledger behind `moss task list`: one row
 * per task run (run, resume, aborted), newest first, with the command that
 * decided the verdict. The real CLI runs are proven separately; this locks the
 * store contract (append/read/torn-line tolerance) and the table projection.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { recordGoalRun, listGoalRuns } = await load('dist/core/task-runtime/goal-runs.js');
const { formatGoalRunRows } = await load('dist/cli/task-list.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[goal-runs] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-runs-'));
const ws = path.join(tmp, 'ws');
await fs.mkdir(ws, { recursive: true });
// Runtime artifacts are only git-ignored inside a git work tree, so give the
// probe workspace a minimal git dir (a .git with HEAD) instead of running git.
await fs.mkdir(path.join(ws, '.git'), { recursive: true });
await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
const now = Date.now();

const passed = await recordGoalRun(ws, {
  taskId: 'task_alpha',
  goal: 'create alpha.txt and verify it',
  phase: 'accepted',
  outcome: 'pass',
  attempts: 1,
  repairs: 0,
  turns: 1,
  startedAt: now - 4_000,
  acceptanceCommand: 'grep -q alpha alpha.txt',
  sessionKey: 'sess-1',
});
const failed = await recordGoalRun(ws, {
  taskId: 'task_beta',
  goal: `${'x'.repeat(180)}tail`,
  phase: 'failed',
  outcome: 'fail',
  attempts: 3,
  repairs: 2,
  turns: 4,
  startedAt: now - 20_000,
});

assert.ok(
  passed.durationMs >= 4_000 && passed.durationMs < 4_100,
  `duration starts from the fixture start; observed ${String(passed.durationMs)}ms`
);
assert.equal(failed.outcome, 'fail');
const rows = await listGoalRuns(ws);
assert.equal(rows.length, 2);
assert.deepEqual(
  rows.map((row) => row.taskId),
  ['task_alpha', 'task_beta'],
  'append order is preserved by the reader'
);
assert.equal(rows[0].acceptanceCommand, 'grep -q alpha alpha.txt');
assert.equal(rows[1].acceptanceCommand, undefined);
assert.equal(rows[0].sessionKey, 'sess-1');
ok('recorded rows round-trip with durations and the deciding command');

const log = path.join(ws, '.moss', 'goals.jsonl');
assert.ok((await fs.readFile(log, 'utf8')).trim().split('\n').length === 2);
const ignore = await fs.readFile(path.join(ws, '.moss', '.gitignore'), 'utf8');
assert.match(ignore, /goals\.jsonl/);
ok('the ledger lives in .moss and is git-ignored like the other runtime artifacts');

await fs.appendFile(log, '{"runId": "torn', 'utf8');
const afterTorn = await listGoalRuns(ws);
assert.equal(afterTorn.length, 2, 'a torn line never hides the records before it');
ok('a torn write does not hide earlier rows');

const lines = formatGoalRunRows(rows, { limit: 20 });
assert.equal(
  lines[0],
  'task runs (2 total · pass 1 · fail 1 · blocked 0 · aborted 0, newest first)'
);
assert.ok(lines.some((line) => line.includes('task_beta') && line.includes('fail')));
assert.ok(lines.some((line) => line.includes('↳ grep -q alpha alpha.txt')));
const sorted = lines.findIndex((line) => line.includes('task_beta'));
const older = lines.findIndex((line) => line.includes('task_alpha'));
assert.ok(sorted < older, 'newest first');
assert.ok(
  lines.every((line) => line.length < 200),
  'long goals are clipped'
);
ok('the table is newest first, clips long goals and shows the deciding command');

const limited = formatGoalRunRows(rows, { limit: 1 });
assert.equal(limited.length, 3, 'header + one row + overflow line');
assert.ok(limited[1].includes('task_beta'));
assert.ok(limited[2].includes('1 more (raise --limit)'));
const zh = formatGoalRunRows(rows, { zh: true, limit: 1 });
assert.ok(zh[0].includes('目标运行记录'));
assert.ok(zh.some((line) => line.includes('失败')));
ok('--limit caps rows and the zh projection is localized');

const emptyDir = path.join(tmp, 'empty');
await fs.mkdir(emptyDir, { recursive: true });
const empty = formatGoalRunRows(await listGoalRuns(emptyDir));
assert.equal(empty.length, 1);
assert.ok(empty[0].includes('no goal runs recorded yet'));
assert.equal((await listGoalRuns(emptyDir)).length, 0);
ok('a workspace without runs reads as empty, not an error');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[goal-runs] ${checks}/6 checks passed`);
