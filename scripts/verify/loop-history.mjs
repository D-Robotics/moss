#!/usr/bin/env node
/**
 * `moss loop list|show` probe (offline).
 *
 * B94 wrote a per-attempt ledger under `.moss/loops/`, but the only reader was
 * `cat`: an overnight loop's evidence was invisible without parsing JSONL by
 * hand. Cursor keeps run history; Claude keeps task directories. This locks the
 * read path: newest-first list, one run's attempt detail, JSON for scripts,
 * interrupted runs (no summary line), torn lines, and exit codes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { listLoopRuns, renderLoopRunRows, formatLoopRunDetail, readLoopHistoryCommand } = await load(
  'dist/cli/loop-command.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-history] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loophistory-'));
const ws = path.join(tmp, 'ws');
const loops = path.join(ws, '.moss', 'loops');
await fs.mkdir(loops, { recursive: true });

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const attempt = (overrides) => ({
  type: 'attempt',
  runId: 'run',
  attempt: 1,
  at: at(10),
  durationMs: 8_400,
  sessionKey: 'run-attempt-1',
  check: { exitCode: 1, durationMs: 120, stdout: 'boom: expected 42 got 41', stderr: '' },
  passed: false,
  ...overrides,
});
const summary = (overrides) => ({
  type: 'summary',
  runId: 'run',
  at: at(10),
  passed: false,
  attempts: 1,
  maxAttempts: 3,
  maxDurationMs: 0,
  totalDurationMs: 9_000,
  reason: 'attempts_exhausted',
  until: 'test -f done.txt',
  ...overrides,
});

const write = async (name, records, minutesAgo) => {
  const file = path.join(loops, name);
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stamp = new Date(Date.now() - minutesAgo * 60_000);
  await fs.utimes(file, stamp, stamp);
};

// passed run (2 attempts), failed run, interrupted run (attempts but no summary),
// and a file whose first line is torn.
await write(
  'loop-pass.jsonl',
  [
    attempt({ runId: 'loop-pass', at: at(30), passed: false }),
    attempt({
      runId: 'loop-pass',
      attempt: 2,
      at: at(29),
      passed: true,
      check: { exitCode: 0, durationMs: 90, stdout: 'ok', stderr: '' },
    }),
    summary({
      runId: 'loop-pass',
      at: at(29),
      passed: true,
      attempts: 2,
      reason: 'passed',
      totalDurationMs: 17_000,
    }),
  ],
  30
);
await write(
  'loop-fail.jsonl',
  [attempt({ runId: 'loop-fail', at: at(20) }), summary({ runId: 'loop-fail', at: at(20) })],
  20
);
await write('loop-cut.jsonl', [attempt({ runId: 'loop-cut', at: at(6) })], 6);
await fs.writeFile(
  path.join(loops, 'loop-torn.jsonl'),
  `${JSON.stringify(attempt({ runId: 'loop-torn', at: at(2) }))}\n{"type":"summary","runId":\n`
);
await fs.utimes(
  path.join(loops, 'loop-torn.jsonl'),
  new Date(Date.now() - 2 * 60_000),
  new Date(Date.now() - 2 * 60_000)
);

const runs = listLoopRuns(ws);
assert.deepEqual(
  runs.map((run) => run.runId),
  ['loop-torn', 'loop-cut', 'loop-fail', 'loop-pass']
);
assert.equal(runs.find((run) => run.runId === 'loop-cut')?.interrupted, true);
assert.equal(runs.find((run) => run.runId === 'loop-pass')?.passed, true);
assert.equal(runs.find((run) => run.runId === 'loop-pass')?.attempts, 2);
ok('listLoopRuns is newest-first, marks interrupted runs, tolerates a torn line');

const rows = renderLoopRunRows(runs, { limit: 10 });
assert.match(rows[0], /loop runs \(4, newest first\)/);
assert.match(rows.join('\n'), /interrupted/);
assert.match(rows.join('\n'), /test -f done\.txt/);
const limited = renderLoopRunRows(runs, { limit: 2 });
assert.equal(limited.length, 6, 'header + 2 rows x 2 lines + overflow line');
assert.match(limited.join('\n'), /2 more \(raise --limit\)/);
assert.match(renderLoopRunRows([], {}).join('\n'), /no loop runs recorded yet/);
ok('the table shows counts, outcomes, the --until command, and limit overflow');

// Interrupt + capture the command's own output.
const capture = async (fn) => {
  const out = [];
  const err = [];
  const originals = { log: console.log, error: console.error };
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    Object.assign(console, originals);
  }
};

const listJson = await capture(() =>
  readLoopHistoryCommand(['list', '--json', '--limit', '2'], { workspaceDir: ws })
);
assert.equal(listJson.code, 0);
const parsed = JSON.parse(listJson.out);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].runId, 'loop-torn');
assert.equal(parsed[0].interrupted, true);
ok('`loop list --json --limit 2` is valid JSON of the newest two runs');

const showPass = await capture(() =>
  readLoopHistoryCommand(['show', 'loop-pass'], { workspaceDir: ws })
);
assert.equal(showPass.code, 0);
assert.match(showPass.out, /loop-pass/);
assert.match(showPass.out, /#2/);
assert.match(showPass.out, /check output: ok/);
assert.match(showPass.out, /passed/);
const showFail = await capture(() =>
  readLoopHistoryCommand(['show', 'latest'], { workspaceDir: ws })
);
assert.equal(showFail.code, 1, 'a failed/interrupted latest run exits 1');
assert.match(showFail.out, /no summary (record|and the process is gone)/);
const showPrefix = await capture(() =>
  readLoopHistoryCommand(['show', 'loop-fa'], { workspaceDir: ws })
);
assert.equal(showPrefix.code, 1);
assert.match(showPrefix.out, /boom: expected 42 got 41/);
ok('`loop show` prints attempt detail, accepts latest/prefix, and exits 1 unless passed');

const showAtt = formatLoopRunDetail(
  runs.find((run) => run.runId === 'loop-fail'),
  { attempts: [attempt({ runId: 'loop-fail' })], summary: summary({ runId: 'loop-fail' }), torn: 0 }
);
assert.match(showAtt.join('\n'), /attempts_exhausted/);
assert.match(showAtt.join('\n'), /check exit 1/);
ok('the detail body names the stop reason and every attempt');

const unknown = await capture(() =>
  readLoopHistoryCommand(['show', 'loop-nope'], { workspaceDir: ws })
);
assert.equal(unknown.code, 1);
assert.match(unknown.err, /no loop run matches loop-nope/);
const badLimit = await capture(() =>
  readLoopHistoryCommand(['list', '--limit', '0'], { workspaceDir: ws })
);
assert.equal(badLimit.code, 2);
const empty = await capture(() =>
  readLoopHistoryCommand(['list'], { workspaceDir: path.join(tmp, 'empty') })
);
assert.equal(empty.code, 0);
assert.match(empty.out, /no loop runs recorded yet/);
ok('unknown ids exit 1, bad --limit exits 2, an empty workspace is not an error');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[loop-history] ${checks}/6 checks passed`);
