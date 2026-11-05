#!/usr/bin/env node
/**
 * `loop list` health + `--status` filter probe (offline).
 *
 * An overnight loop leaves one ledger per run, so after a week `list` shows a
 * page of rows with no answer to "how is this loop doing overall?". Cursor's
 * run view and Claude's task list show aggregate status. The header now counts
 * every status in the whole ledger (not just the page), and `--status` narrows
 * the table/JSON to one status. This locks counts, filtering, and the failure
 * mode for a bad status.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { listLoopRuns, renderLoopRunRows, summarizeLoopRuns, readLoopHistoryCommand } = await import(
  dist('cli/loop-command.js')
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-health] ok ${name}`);
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'moss-loophealth-'));
const ws = path.join(tmp, 'ws');
const loops = path.join(ws, '.moss', 'loops');
await fsp.mkdir(loops, { recursive: true });

const now = Date.now();
const start = (runId, pid) => ({
  type: 'start',
  runId,
  at: new Date(now - 60_000).toISOString(),
  pid,
  until: 'true',
  maxAttempts: 3,
  prompt: 'p',
});
const attempt = (runId, at) => ({
  type: 'attempt',
  runId,
  attempt: 1,
  at,
  durationMs: 1_000,
  sessionKey: runId,
  check: { exitCode: 1, durationMs: 5, stdout: '', stderr: '' },
  passed: false,
});
const summary = (runId, passed, reason) => ({
  type: 'summary',
  runId,
  at: new Date(now - 30_000).toISOString(),
  passed,
  attempts: 1,
  maxAttempts: 3,
  maxDurationMs: 0,
  totalDurationMs: 1_000,
  reason,
  until: 'true',
});
const write = async (runId, records) => {
  const file = path.join(loops, `${runId}.jsonl`);
  await fsp.writeFile(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
};

// Two passed, one failed, one check_timeout (also a failed outcome), one
// running (live pid, no summary), one interrupted (dead pid, no summary).
const passedA = await write('loop-p1', [
  start('loop-p1', 1),
  attempt('loop-p1', new Date(now).toISOString()),
  summary('loop-p1', true, 'passed'),
]);
const passedB = await write('loop-p2', [
  start('loop-p2', 2),
  attempt('loop-p2', new Date(now).toISOString()),
  summary('loop-p2', true, 'passed'),
]);
const failed = await write('loop-f1', [
  start('loop-f1', 3),
  attempt('loop-f1', new Date(now).toISOString()),
  summary('loop-f1', false, 'attempts_exhausted'),
]);
const timeoutRun = await write('loop-t1', [
  start('loop-t1', 4),
  attempt('loop-t1', new Date(now).toISOString()),
  summary('loop-t1', false, 'check_timeout'),
]);
const running = await write('loop-r1', [
  start('loop-r1', process.pid),
  attempt('loop-r1', new Date(now).toISOString()),
]);
const interrupted = await write('loop-i1', [
  start('loop-i1', 2_147_483_646),
  attempt('loop-i1', new Date(now).toISOString()),
]);
// Distinct mtimes: newest first must be deterministic.
const ordered = [passedA, passedB, failed, timeoutRun, running, interrupted];
ordered.forEach((file, index) => {
  const time = new Date(now - (ordered.length - index) * 1_000);
  fs.utimesSync(file, time, time);
});

const runs = listLoopRuns(ws);
assert.equal(runs.length, 6);
const counts = summarizeLoopRuns(runs);
assert.deepEqual(counts, { total: 6, passed: 2, failed: 2, running: 1, interrupted: 1 });
ok('counts cover every status across the whole ledger');

const rows = renderLoopRunRows(runs, { zh: false });
assert.match(
  rows[0],
  /loop runs \(6 total · passed 2 · failed 2 · running 1 · interrupted 1, newest first\)/
);
assert.equal(rows.length, 1 + 6 * 2, 'one header line plus two lines per run');
ok('the header counts all runs, newest first');

const filtered = renderLoopRunRows(runs, { zh: false, status: 'running' });
assert.match(filtered[0], /— status running \(1\)/);
assert.equal(filtered.length, 3, 'header + one two-line run');
assert.match(filtered[1], /running/);
assert.match(filtered[1], /loop-r1/);
ok('--status running narrows the table and keeps the per-status count');

const failRows = renderLoopRunRows(runs, { zh: false, status: 'failed' });
assert.match(failRows[0], /— status failed \(2\)/, 'check_timeout counts as failed');
assert.ok(
  failRows.some((line) => line.includes('check timed out (hang)')),
  'the timeout run keeps its own reason under status failed'
);
ok('--status failed includes exhausted and check_timeout runs');

const noneRows = renderLoopRunRows(
  runs.filter((run) => run.runId !== 'loop-r1'),
  { zh: false, status: 'running' }
);
assert.ok(
  noneRows.some((line) => line.includes('no runs with status running')),
  'an empty filter result is a line, not an error'
);
ok('a filter with no matches reports it without failing');

// Command path: filtering, JSON, and the bad-status exit code.
const capture = async (argv) => {
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => lines.push(parts.join(' '));
  console.error = (...parts) => lines.push(parts.join(' '));
  try {
    const code = await readLoopHistoryCommand(argv, { workspaceDir: ws });
    return { code, text: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
};
const json = await capture(['list', '--json', '--status', 'fail']);
assert.equal(json.code, 0);
const parsed = JSON.parse(json.text);
assert.equal(parsed.length, 2, '--json --status fail returns the two failed runs');
assert.ok(parsed.every((run) => run.status === 'failed'));
const bad = await capture(['list', '--status', 'sometimes']);
assert.equal(bad.code, 2);
assert.match(bad.text, /--status must be one of/);
const statusTable = await capture(['list', '--status', 'interrupted']);
assert.equal(statusTable.code, 0);
assert.match(statusTable.text, /interrupted \(1\)/);
ok('the command filters table and JSON, and rejects an unknown status');

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`[loop-health] ${checks}/6 checks passed`);
