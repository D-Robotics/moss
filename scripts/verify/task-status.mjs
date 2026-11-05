#!/usr/bin/env node
/**
 * `moss task list` health header + `--status` filter probe (offline).
 *
 * `.moss/goals.jsonl` accumulates one row per task run across sessions, so
 * after a week `task list` showed a page of rows with no answer to "how are my
 * task runs doing overall?" and no way to ask "show me the failures" without
 * eyeballing rows or piping `--json` into jq. The header now counts every
 * outcome in the whole ledger (not just the page), and `--status` narrows the
 * table/JSON to one outcome while keeping the global counts (B111, mirroring
 * B106's `loop list`). This probe crafts both ledgers on disk and runs the real
 * CLI, so it locks counts, filtering, the aliases, the empty-filter line and
 * the bad-status exit code. It does not start an agent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist', 'cli.js');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-status-'));
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
  console.log(`[task-status] ok ${name}`);
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
  return result;
}

async function runOk(workspace, args = [], env = {}) {
  const result = await runList(workspace, args, env);
  assert.equal(
    result.status,
    0,
    `task list ${args.join(' ')} exited ${String(result.status)}: ${result.stderr.slice(-600)}`
  );
  return result.stdout;
}

/** The header is the first `task runs (` line; continuation lines never start with it. */
function headerOf(stdout) {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('task runs ('));
  assert.ok(line, `no task-runs header in: ${stdout.slice(0, 400)}`);
  return line;
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
    ...(overrides.blockedReason ? { blockedReason: overrides.blockedReason } : {}),
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
const abortedStart = now - 300_000;
const blockedStart = now - 400_000;
const failStart = now - 500_000;
const passBStart = now - 600_000;
const passAStart = now - 700_000;

const workspace = path.join(tmp, 'workspace');
await fs.mkdir(path.join(workspace, '.moss'), { recursive: true });
await writeJsonl(path.join(workspace, '.moss', 'goals.jsonl'), [
  goalRun({
    taskId: 'task_pass_a',
    goal: 'create alpha.txt',
    outcome: 'pass',
    startedAt: passAStart,
    endedAt: passAStart + 60_000,
    acceptanceCommand: 'test -f alpha.txt',
  }),
  goalRun({
    taskId: 'task_fail',
    goal: 'make the build green',
    outcome: 'fail',
    attempts: 2,
    repairs: 1,
    turns: 3,
    startedAt: failStart,
    endedAt: failStart + 60_000,
    acceptanceCommand: 'npm test',
  }),
  goalRun({
    taskId: 'task_pass_b',
    goal: 'create beta.txt',
    outcome: 'pass',
    startedAt: passBStart,
    endedAt: passBStart + 60_000,
  }),
  goalRun({
    taskId: 'task_blocked',
    goal: 'deploy to the device',
    outcome: 'blocked',
    startedAt: blockedStart,
    endedAt: blockedStart + 60_000,
    blockedReason: 'acceptance command is unavailable',
  }),
  goalRun({
    taskId: 'task_aborted',
    goal: 'long refactor',
    outcome: 'aborted',
    startedAt: abortedStart,
    endedAt: abortedStart + 60_000,
  }),
]);
await writeJsonl(path.join(workspace, '.moss', 'review.jsonl'), [
  reviewRecord({
    id: 'rev_fail',
    createdAtMs: failStart + 64_000,
    verdict: 'fail',
    findings: [
      { severity: 'critical', title: 'drops the retry' },
      { severity: 'critical', title: 'silently swallows the error' },
      { severity: 'important', title: 'no test for the timeout path' },
    ],
  }),
]);

// 1. Header counts every outcome across the whole ledger, newest first.
const table = await runOk(workspace, [], { MOSS_LANG: 'en', LC_ALL: 'C' });
assert.equal(
  headerOf(table),
  'task runs (5 total · pass 2 · fail 1 · blocked 1 · aborted 1, newest first)'
);
const order = ['task_aborted', 'task_blocked', 'task_fail', 'task_pass_b', 'task_pass_a'];
const indexes = order.map((taskId) => table.indexOf(taskId));
assert.ok(
  indexes.every((index) => index !== -1),
  `missing rows in: ${table}`
);
assert.deepEqual(
  indexes,
  [...indexes].sort((left, right) => left - right),
  'newest first'
);
const zhTable = await runOk(workspace, [], { MOSS_LANG: 'zh', LC_ALL: 'C' });
assert.match(zhTable, /目标运行记录（共 5 次 · 通过 2 · 失败 1 · 阻塞 1 · 已中止 1，最新在前）/);
ok('the header counts every outcome over the whole ledger and rows are newest first');

// 2. `--status fail` narrows the table, keeps global counts, and the B108
//    review/acceptance continuation lines survive on the filtered row.
const failTable = await runOk(workspace, ['--status', 'fail'], {
  MOSS_LANG: 'en',
  LC_ALL: 'C',
});
assert.equal(
  headerOf(failTable),
  'task runs (5 total · pass 2 · fail 1 · blocked 1 · aborted 1, newest first) — status fail (1)'
);
assert.ok(failTable.includes('task_fail'), 'the filtered row is shown');
for (const other of ['task_pass_a', 'task_pass_b', 'task_blocked', 'task_aborted']) {
  assert.ok(!failTable.includes(other), `${other} must not appear under --status fail`);
}
assert.ok(failTable.includes('↳ npm test'), 'the acceptance command line survives filtering');
assert.ok(
  failTable.includes('↳ review FAIL · 2 critical, 1 important (record rev_fail)'),
  'the review projection line survives filtering'
);
ok('--status fail narrows the table and keeps the review + acceptance lines');

// 3. `passed`/`failed` aliases; --limit applies to the filtered rows and the
//    overflow line counts the filtered set, not the whole ledger.
const passedTable = await runOk(workspace, ['--status', 'passed'], {
  MOSS_LANG: 'en',
  LC_ALL: 'C',
});
assert.match(headerOf(passedTable), /— status pass \(2\)$/);
assert.ok(passedTable.includes('task_pass_a') && passedTable.includes('task_pass_b'));
const failedTable = await runOk(workspace, ['--status', 'failed'], {
  MOSS_LANG: 'en',
  LC_ALL: 'C',
});
assert.match(headerOf(failedTable), /— status fail \(1\)$/);
const limited = await runOk(workspace, ['--status', 'pass', '--limit', '1'], {
  MOSS_LANG: 'en',
  LC_ALL: 'C',
});
assert.match(headerOf(limited), /— status pass \(2\)$/, 'the header counts the filtered set');
assert.ok(limited.includes('task_pass_b'), 'newest filtered row is kept');
assert.ok(!limited.includes('task_pass_a'), '--limit caps the filtered rows');
assert.ok(limited.includes('1 more (raise --limit)'), 'the overflow line counts the filtered set');
ok('passed/failed aliases work and --limit/overflow apply to the filtered set');

// 4. `--json` filtering returns only the requested outcome and keeps the
//    structured review object.
const jsonAll = JSON.parse(await runOk(workspace, ['--json'], { MOSS_LANG: 'en', LC_ALL: 'C' }));
assert.equal(jsonAll.length, 5, '--json without a filter still returns every run');
const jsonFail = JSON.parse(
  await runOk(workspace, ['--json', '--status', 'fail'], { MOSS_LANG: 'en', LC_ALL: 'C' })
);
assert.equal(jsonFail.length, 1, '--json --status fail returns only the failed run');
assert.equal(jsonFail[0].taskId, 'task_fail');
assert.equal(jsonFail[0].outcome, 'fail');
assert.equal(jsonFail[0].acceptanceCommand, 'npm test');
assert.deepEqual(jsonFail[0].review, {
  id: 'rev_fail',
  verdict: 'FAIL',
  critical: 2,
  important: 1,
  suggestion: 0,
  total: 3,
});
ok('--json respects --status and keeps the structured review object');

// 5. A filter with no matches prints a line and exits 0 (never an error).
const emptyWorkspace = path.join(tmp, 'empty-workspace');
await fs.mkdir(path.join(emptyWorkspace, '.moss'), { recursive: true });
await writeJsonl(path.join(emptyWorkspace, '.moss', 'goals.jsonl'), [
  goalRun({
    taskId: 'task_only_pass',
    goal: 'create gamma.txt',
    outcome: 'pass',
    startedAt: now - 60_000,
    endedAt: now - 30_000,
  }),
]);
const emptyFilter = await runOk(emptyWorkspace, ['--status', 'blocked'], {
  MOSS_LANG: 'en',
  LC_ALL: 'C',
});
assert.equal(
  headerOf(emptyFilter),
  'task runs (1 total · pass 1 · fail 0 · blocked 0 · aborted 0, newest first) — status blocked (0)'
);
assert.ok(
  emptyFilter.includes('no task runs with status blocked'),
  `empty filter line missing: ${emptyFilter}`
);
assert.ok(!emptyFilter.includes('task_only_pass'), 'no row is invented for an empty filter');
ok('a filter with no matches prints a line and exits 0');

// 6. A bad status (or a bad --limit) is a usage error, exit 2, no table.
const badStatus = await runList(workspace, ['--status', 'nope'], { MOSS_LANG: 'en', LC_ALL: 'C' });
assert.equal(badStatus.status, 2, `bad --status exited ${String(badStatus.status)}`);
assert.match(
  badStatus.stderr,
  /--status must be one of pass\|fail\|blocked\|aborted/,
  `bad --status stderr: ${badStatus.stderr.slice(-400)}`
);
assert.equal(badStatus.stdout.trim(), '', 'a bad status must not print a table');
const badLimit = await runList(workspace, ['--limit', '0'], { MOSS_LANG: 'en', LC_ALL: 'C' });
assert.equal(badLimit.status, 2, `bad --limit exited ${String(badLimit.status)}`);
assert.match(badLimit.stderr, /--limit must be a positive integer/);
ok('a bad --status/--limit exits 2 with a usage error and no table');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[task-status] ${String(checks)} checks passed`);
