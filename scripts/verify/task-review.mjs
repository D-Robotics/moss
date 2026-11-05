#!/usr/bin/env node
/**
 * `moss task list` review projection probe (offline).
 *
 * The goal-run rollup (`goals.jsonl`) records the outcome, but the verdict that
 * decided a run lives in `.moss/review.jsonl`. This probe crafts both ledgers
 * on disk and runs the real CLI, so it locks the projection contract:
 *
 * - a review record inside the run window is projected (latest window wins,
 *   FAIL counts + record id, PASS with zero findings);
 * - records before the window or past `endedAt + 5s` never appear on that row;
 * - a missing `review.jsonl` and a torn trailing line are tolerated;
 * - `--json` rows carry the structured `review` object and keep the
 *   acceptance command; rows without a review have no `review` key;
 * - the table wording exists in both en and zh.
 *
 * It does not start an agent: real review runs are proven separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist', 'cli.js');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-review-'));
const home = path.join(tmp, 'home');
const configDir = path.join(tmp, 'config');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(configDir, { recursive: true });
// `task list` never calls a model, but the CLI's preflight requires a resolved
// provider/model. A fake local config keeps the probe offline and hermetic.
await fs.writeFile(
  path.join(configDir, 'config.json'),
  `${JSON.stringify({
    provider: 'openai-compatible',
    model: 'deepseek-flash@latest',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-probe',
  })}\n`,
  { mode: 0o600 }
);

const baseEnv = {
  ...process.env,
  HOME: home,
  MOSS_CONFIG_DIR: configDir,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_NO_TUI: '1',
};

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[task-review] ok ${name}`);
}

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

async function runList(workspace, args = [], env = {}) {
  const result = await captureProcess(process.execPath, [cli, 'task', 'list', ...args], {
    cwd: workspace,
    env: { ...baseEnv, ...env },
    timeoutMs: 60_000,
  });
  assert.equal(result.timedOut, false, 'task list timed out');
  assert.equal(
    result.status,
    0,
    `task list exited ${String(result.status)}: ${result.stderr.slice(-600)}`
  );
  return result.stdout;
}

/** Continuation (`↳`) lines that belong to the row containing `taskId`. */
function continuationLines(table, taskId) {
  const lines = table.split('\n');
  const index = lines.findIndex((line) => line.includes(taskId));
  assert.notEqual(index, -1, `table has no row for ${taskId}`);
  const out = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (!line.startsWith('↳')) break;
    out.push(line);
  }
  return out;
}

function goalRun(overrides) {
  return {
    version: 1,
    runId: `goal-fixture-${overrides.taskId}`,
    taskId: overrides.taskId,
    goal: overrides.goal,
    phase: overrides.outcome === 'pass' ? 'accepted' : 'failed',
    outcome: overrides.outcome,
    attempts: overrides.attempts ?? 1,
    repairs: overrides.repairs ?? 0,
    turns: overrides.turns ?? 1,
    startedAt: overrides.startedAt,
    endedAt: overrides.endedAt,
    durationMs: overrides.endedAt - overrides.startedAt,
    ...(overrides.acceptanceCommand ? { acceptanceCommand: overrides.acceptanceCommand } : {}),
  };
}

function reviewRecord(overrides) {
  return {
    id: overrides.id,
    createdAt: new Date(overrides.createdAtMs).toISOString(),
    verdict: overrides.verdict,
    reviewerSuccess: overrides.reviewerSuccess ?? true,
    findings: overrides.findings ?? [],
  };
}

const now = Date.now();
const failStart = now - 3_600_000;
const failEnd = failStart + 60_000;
const oldStart = failStart - 900_000;
const oldEnd = oldStart + 60_000;
const bareStart = failStart + 600_000;
const bareEnd = bareStart + 60_000;

const workspace = path.join(tmp, 'workspace');
await fs.mkdir(path.join(workspace, '.moss'), { recursive: true });
await writeJsonl(path.join(workspace, '.moss', 'goals.jsonl'), [
  goalRun({
    taskId: 'task_old',
    goal: 'add the older note',
    outcome: 'pass',
    startedAt: oldStart,
    endedAt: oldEnd,
    acceptanceCommand: 'test -f old.txt',
  }),
  goalRun({
    taskId: 'task_fail',
    goal: 'make the build green',
    outcome: 'fail',
    attempts: 2,
    repairs: 1,
    turns: 3,
    startedAt: failStart,
    endedAt: failEnd,
    acceptanceCommand: 'npm test',
  }),
  goalRun({
    taskId: 'task_bare',
    goal: 'no review was run here',
    outcome: 'pass',
    startedAt: bareStart,
    endedAt: bareEnd,
  }),
]);
const reviewLog = path.join(workspace, '.moss', 'review.jsonl');
const reviewRows = [
  // Inside the older run's window.
  reviewRecord({ id: 'rev_old', createdAtMs: oldStart + 20_000, verdict: 'pass' }),
  // Inside task_fail's window but earlier: the later FAIL must win.
  reviewRecord({ id: 'rev_early', createdAtMs: failStart + 5_000, verdict: 'pass' }),
  reviewRecord({
    id: 'rev_fail',
    createdAtMs: failEnd + 4_000,
    verdict: 'fail',
    repairAttempt: 1,
    findings: [
      { severity: 'critical', title: 'drops the retry' },
      { severity: 'critical', title: 'silently swallows the error' },
      { severity: 'important', title: 'no test for the timeout path' },
    ],
  }),
  // After endedAt + 5s: belongs to a later run, not task_fail.
  reviewRecord({
    id: 'rev_outside',
    createdAtMs: failEnd + 20_000,
    verdict: 'fail',
    findings: [
      { severity: 'critical', title: 'a' },
      { severity: 'critical', title: 'b' },
      { severity: 'critical', title: 'c' },
      { severity: 'critical', title: 'd' },
    ],
  }),
];
await writeJsonl(reviewLog, reviewRows);
// A torn trailing line (process died mid-append) must not hide the record above.
await fs.appendFile(reviewLog, '{"id":"rev_torn","createdAt":"', 'utf8');

const table = await runList(workspace, [], { MOSS_LANG: 'en', LC_ALL: 'C' });
const failLines = continuationLines(table, 'task_fail');
assert.ok(
  failLines.includes('↳ review FAIL · 2 critical, 1 important (record rev_fail)'),
  `task_fail continuation lines: ${JSON.stringify(failLines)}`
);
assert.ok(failLines.includes('↳ npm test'), 'the acceptance command line must survive');
assert.ok(
  failLines.every((line) => !line.includes('rev_early') && !line.includes('rev_outside')),
  'earlier and out-of-window records must not be projected'
);
assert.doesNotMatch(table, /rev_torn/, 'the torn line is not a record');
ok('an in-window review FAIL is projected with counts and record id, latest wins');

const oldLines = continuationLines(table, 'task_old');
assert.ok(
  oldLines.includes('↳ review PASS · 0 findings (record rev_old)'),
  `task_old continuation lines: ${JSON.stringify(oldLines)}`
);
assert.ok(
  continuationLines(table, 'task_bare').every((line) => !line.startsWith('↳ review')),
  'a run without a review record shows no review line'
);
assert.ok(
  !oldLines.some((line) => line.startsWith('↳ review') && !line.includes('rev_old')),
  'the older run projects only a record from its own window'
);
ok('each run projects only a record inside its own window (PASS wording included)');

const missingWorkspace = path.join(tmp, 'missing-review');
await fs.mkdir(path.join(missingWorkspace, '.moss'), { recursive: true });
await writeJsonl(path.join(missingWorkspace, '.moss', 'goals.jsonl'), [
  goalRun({
    taskId: 'task_no_log',
    goal: 'review ledger never existed',
    outcome: 'fail',
    startedAt: now - 60_000,
    endedAt: now - 30_000,
  }),
]);
const missingTable = await runList(missingWorkspace, [], { MOSS_LANG: 'en', LC_ALL: 'C' });
assert.match(missingTable, /task_no_log/);
assert.doesNotMatch(missingTable, /↳ review/, 'a missing review.jsonl must not invent a verdict');
ok('a missing .moss/review.jsonl is tolerated (row still lists, no review line)');

const jsonRows = JSON.parse(await runList(workspace, ['--json'], { MOSS_LANG: 'en', LC_ALL: 'C' }));
const byTask = new Map(jsonRows.map((row) => [row.taskId, row]));
assert.deepEqual(byTask.get('task_fail')?.review, {
  id: 'rev_fail',
  verdict: 'FAIL',
  critical: 2,
  important: 1,
  suggestion: 0,
  total: 3,
});
assert.deepEqual(byTask.get('task_old')?.review, {
  id: 'rev_old',
  verdict: 'PASS',
  critical: 0,
  important: 0,
  suggestion: 0,
  total: 0,
});
assert.equal(byTask.get('task_fail')?.acceptanceCommand, 'npm test');
assert.ok(byTask.get('task_bare'));
assert.ok(!('review' in byTask.get('task_bare')), 'rows without a review carry no review key');
ok('--json rows gain the structured review object only when a record is in window');

const zhTable = await runList(workspace, [], { MOSS_LANG: 'zh', LC_ALL: 'C' });
assert.match(zhTable, /目标运行记录/);
assert.ok(
  continuationLines(zhTable, 'task_fail').includes(
    '↳ 评审 失败 · 2 个严重、1 个重要（记录 rev_fail）'
  ),
  `zh task_fail lines: ${JSON.stringify(continuationLines(zhTable, 'task_fail'))}`
);
assert.ok(
  continuationLines(zhTable, 'task_old').includes('↳ 评审 通过 · 0 项发现（记录 rev_old）'),
  `zh task_old lines: ${JSON.stringify(continuationLines(zhTable, 'task_old'))}`
);
ok('the review line is localized in zh');

console.log(`[task-review] ${String(checks)} checks passed`);
