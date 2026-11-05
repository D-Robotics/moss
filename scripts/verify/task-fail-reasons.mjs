#!/usr/bin/env node
/**
 * `moss task list` failure-reason probe (offline).
 *
 * The goal-run rollup (`goals.jsonl`) records the outcome and the acceptance
 * command, but the symptom the agent recorded in `.moss/task-failures.jsonl`
 * is what explains *why* a run failed. This probe crafts both ledgers on disk
 * and runs the real CLI, locking the projection contract:
 *
 * - fail/blocked rows render `↳ <first line of symptom>` under the acceptance
 *   line; only the first line, capped at 120 chars;
 * - a symptom that just repeats the acceptance command is skipped;
 * - a failure that was later marked resolved loses to the latest unresolved
 *   one, and the latest record wins when every failure is resolved;
 * - pass rows stay clean even when the task has failure records;
 * - a missing/torn `.moss/task-failures.jsonl` is tolerated;
 * - `--json` fail/blocked rows gain `{stage, symptom, resolved}`, pass rows do
 *   not, and it composes with `--status` and the B108 `review` object;
 * - the zh table labels the line `↳ 原因：…`.
 *
 * It does not start an agent: real failure runs are proven separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist', 'cli.js');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-fail-reasons-'));
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
  console.log(`[task-fail-reasons] ok ${name}`);
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
    ...(overrides.blockedReason ? { blockedReason: overrides.blockedReason } : {}),
  };
}

function failure(overrides) {
  return {
    failureId: overrides.failureId,
    taskId: overrides.taskId,
    stage: overrides.stage ?? 'verifying',
    symptom: overrides.symptom,
    attempt: overrides.attempt ?? 1,
    resolved: overrides.resolved === true,
    timestamp: overrides.timestamp,
  };
}

const now = Date.now();
const failStart = now - 3_600_000;
const failEnd = failStart + 60_000;
const workspace = path.join(tmp, 'workspace');
await fs.mkdir(path.join(workspace, '.moss'), { recursive: true });
await writeJsonl(path.join(workspace, '.moss', 'goals.jsonl'), [
  goalRun({
    taskId: 'task_fail',
    goal: 'make the build green',
    outcome: 'fail',
    attempts: 2,
    startedAt: failStart,
    endedAt: failEnd,
    acceptanceCommand: 'npm test',
  }),
  goalRun({
    taskId: 'task_dup',
    goal: 'rebuild the bundle',
    outcome: 'fail',
    startedAt: failStart,
    endedAt: failEnd,
    acceptanceCommand: 'npm run build',
  }),
  goalRun({
    taskId: 'task_blocked',
    goal: 'probe the device',
    outcome: 'blocked',
    startedAt: failStart,
    endedAt: failEnd,
    acceptanceCommand: 'npm run verify',
    blockedReason: 'waiting for the device',
  }),
  goalRun({
    taskId: 'task_pass',
    goal: 'add the older note',
    outcome: 'pass',
    startedAt: failStart,
    endedAt: failEnd,
    acceptanceCommand: 'npm test',
  }),
  goalRun({
    taskId: 'task_resolved',
    goal: 'every failure was eventually fixed',
    outcome: 'fail',
    startedAt: failStart,
    endedAt: failEnd,
  }),
  goalRun({
    taskId: 'task_unresolved',
    goal: 'the last failure was never fixed',
    outcome: 'fail',
    startedAt: failStart,
    endedAt: failEnd,
    acceptanceCommand: 'npm test',
  }),
]);
await writeJsonl(path.join(workspace, '.moss', 'review.jsonl'), [
  {
    id: 'rev_fail',
    createdAt: new Date(failStart + 20_000).toISOString(),
    verdict: 'fail',
    reviewerSuccess: true,
    findings: [
      { severity: 'critical', title: 'drops the retry' },
      { severity: 'critical', title: 'swallows the error' },
      { severity: 'important', title: 'no timeout test' },
    ],
  },
]);
const failuresLog = path.join(workspace, '.moss', 'task-failures.jsonl');
// task_fail: two versions under the same failureId; the later unresolved one wins.
await writeJsonl(failuresLog, [
  failure({
    failureId: 'f_fail',
    taskId: 'task_fail',
    symptom: 'expected exit 0 but got 1\nstdout: 1 failing test',
    resolved: true,
    timestamp: failStart + 10_000,
  }),
  failure({
    failureId: 'f_fail',
    taskId: 'task_fail',
    symptom: 'expected exit 0 but got 1',
    resolved: false,
    timestamp: failStart + 20_000,
  }),
  // task_dup: the symptom just repeats the acceptance command.
  failure({
    failureId: 'f_dup',
    taskId: 'task_dup',
    symptom: 'npm run build',
    resolved: false,
    timestamp: failStart + 10_000,
  }),
  // task_blocked: multi-line symptom renders only its first line.
  failure({
    failureId: 'f_blocked',
    taskId: 'task_blocked',
    symptom: 'waiting for the device\nprobe: connection refused',
    resolved: false,
    timestamp: failStart + 10_000,
  }),
  // task_pass: resolved history is present, but a passing row shows no reason.
  failure({
    failureId: 'f_pass',
    taskId: 'task_pass',
    symptom: 'flaky test detected',
    resolved: false,
    timestamp: failStart + 10_000,
  }),
  // task_resolved: every failure is resolved, so the latest one answers.
  failure({
    failureId: 'f_res_old',
    taskId: 'task_resolved',
    symptom: 'old failure fixed',
    resolved: true,
    timestamp: failStart + 10_000,
  }),
  failure({
    failureId: 'f_res_new',
    taskId: 'task_resolved',
    symptom: 'newest failure still reported',
    resolved: true,
    timestamp: failStart + 30_000,
  }),
  // task_unresolved: a later unresolved failure outranks the earlier resolved one.
  failure({
    failureId: 'f_unres_old',
    taskId: 'task_unresolved',
    symptom: 'earlier resolved symptom',
    resolved: true,
    timestamp: failStart + 10_000,
  }),
  failure({
    failureId: 'f_unres_new',
    taskId: 'task_unresolved',
    symptom: 'later unresolved symptom',
    resolved: false,
    timestamp: failStart + 30_000,
  }),
]);
// A torn trailing line (process died mid-append) must not hide the records above.
await fs.appendFile(failuresLog, '{"failureId":"f_torn","taskId":"task_fa', 'utf8');

const table = await runList(workspace, [], { MOSS_LANG: 'en', LC_ALL: 'C' });
const failLines = continuationLines(table, 'task_fail');
assert.ok(
  failLines.includes('↳ expected exit 0 but got 1'),
  `task_fail continuation lines: ${JSON.stringify(failLines)}`
);
assert.ok(failLines.includes('↳ npm test'), 'the acceptance command line must survive');
const blockedLines = continuationLines(table, 'task_blocked');
assert.ok(
  blockedLines.includes('↳ waiting for the device'),
  `task_blocked continuation lines: ${JSON.stringify(blockedLines)}`
);
assert.ok(blockedLines.includes('↳ npm run verify'), 'the blocked row keeps its acceptance line');
assert.ok(
  blockedLines.every((line) => !line.includes('connection refused')),
  'only the first symptom line is rendered'
);
ok('fail and blocked rows render the recorded symptom (first line only) after the acceptance line');

const dupLines = continuationLines(table, 'task_dup');
assert.equal(
  dupLines.filter((line) => line === '↳ npm run build').length,
  1,
  `task_dup continuation lines: ${JSON.stringify(dupLines)}`
);
ok('a symptom that repeats the acceptance command is skipped, not printed twice');

assert.ok(
  continuationLines(table, 'task_unresolved').includes('↳ later unresolved symptom'),
  'the latest unresolved failure outranks an earlier resolved one'
);
assert.ok(
  continuationLines(table, 'task_resolved').includes('↳ newest failure still reported'),
  'when every failure is resolved the latest record answers'
);
assert.ok(
  continuationLines(table, 'task_resolved').every((line) => !line.includes('old failure fixed')),
  'the older resolved failure is not projected'
);
ok('latest-unresolved wins, then the latest overall record');

assert.ok(
  table.split('\n').every((line) => !line.includes('flaky test detected')),
  'a passing row must not show a failure reason'
);
const missingWorkspace = path.join(tmp, 'missing-failures');
await fs.mkdir(path.join(missingWorkspace, '.moss'), { recursive: true });
await writeJsonl(path.join(missingWorkspace, '.moss', 'goals.jsonl'), [
  goalRun({
    taskId: 'task_no_ledger',
    goal: 'failed without a failure ledger',
    outcome: 'fail',
    startedAt: now - 60_000,
    endedAt: now - 30_000,
    acceptanceCommand: 'test -f note.txt',
  }),
]);
const missingTable = await runList(missingWorkspace, [], { MOSS_LANG: 'en', LC_ALL: 'C' });
assert.deepEqual(
  continuationLines(missingTable, 'task_no_ledger'),
  ['↳ test -f note.txt'],
  'a missing task-failures.jsonl leaves only the acceptance line'
);
ok('a missing failure ledger and a torn tail line are tolerated');

const jsonRows = JSON.parse(await runList(workspace, ['--json'], { MOSS_LANG: 'en', LC_ALL: 'C' }));
const byTask = new Map(jsonRows.map((row) => [row.taskId, row]));
assert.deepEqual(byTask.get('task_fail')?.failure, {
  stage: 'verifying',
  symptom: 'expected exit 0 but got 1',
  resolved: false,
});
assert.deepEqual(byTask.get('task_blocked')?.failure, {
  stage: 'verifying',
  symptom: 'waiting for the device\nprobe: connection refused',
  resolved: false,
});
assert.ok(!('failure' in byTask.get('task_pass')), '--json pass rows must not gain a failure key');
assert.deepEqual(byTask.get('task_fail')?.review, {
  id: 'rev_fail',
  verdict: 'FAIL',
  critical: 2,
  important: 1,
  suggestion: 0,
  total: 3,
});
const failedJson = JSON.parse(
  await runList(workspace, ['--json', '--status', 'fail'], { MOSS_LANG: 'en', LC_ALL: 'C' })
);
assert.equal(failedJson.length, 4, '--json --status fail returns the four failed runs');
assert.ok(
  failedJson.every((row) => row.outcome === 'fail' && row.failure && row.failure.symptom),
  'every filtered fail row carries its failure record'
);
ok('--json fail/blocked rows gain {stage, symptom, resolved} and compose with --status/review');

const zhTable = await runList(workspace, [], { MOSS_LANG: 'zh', LC_ALL: 'C' });
assert.ok(
  continuationLines(zhTable, 'task_fail').includes('↳ 原因：expected exit 0 but got 1'),
  `zh task_fail lines: ${JSON.stringify(continuationLines(zhTable, 'task_fail'))}`
);
ok('the failure reason line is localized in zh as ↳ 原因：…');

console.log(`[task-fail-reasons] ${String(checks)} checks passed`);
