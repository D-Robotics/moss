#!/usr/bin/env node
/**
 * Resume budget probe (offline, B114).
 *
 * `moss task resume` is a retry, but it used to ignore `--max-repairs` /
 * `--max-turns` entirely: every resume silently got a fresh full budget. This
 * locks that a resume can narrow the budget for that attempt (and that the
 * defaults still apply when the flags are absent).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { runTask, resumeTask, DEFAULT_MAX_REPAIR_ATTEMPTS, DEFAULT_MAX_TURNS } = await load(
  'dist/core/task/task-engine.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[resume-budget] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-resume-budget-'));
const ws = path.join(tmp, 'ws');
await fs.mkdir(path.join(ws, '.git'), { recursive: true });
await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

const failingProvider = {
  source: 'command',
  evaluate: async (taskId) => ({
    taskId,
    passed: false,
    source: 'command',
    detail: 'acceptance command failed (exit 1)\n',
  }),
};

/** Run a task that fails immediately, then return its id plus the live state. */
async function failedTask(goal) {
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn: async () => 'did something',
      verdictProvider: failingProvider,
      maxRepairAttempts: 0,
    },
    goal
  );
  assert.equal(result.outcome, 'fail');
  assert.equal(result.snapshot.attempt, 1, 'the seed run spends exactly one verification');
  return result.snapshot.taskId;
}

const phasesOf = () => {
  const phases = [];
  return { phases, deps: () => ({ onProgress: (p) => phases.push(p.phase) }) };
};

// 1. The seed run leaves the task failed with one attempt behind it.
const taskId = await failedTask('seed a failed task');
ok('a failed task starts from one recorded verification');

// 2. `resume --max-repairs 0`: one new verification, no repair turn. Without the
//    override the default budget (5) would have spent repair turns here.
{
  const { phases, deps } = phasesOf();
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => 'still failing',
      verdictProvider: failingProvider,
      ...deps(),
    },
    taskId,
    { maxRepairAttempts: 0 }
  );
  assert.equal(resumed.outcome, 'fail');
  assert.equal(resumed.snapshot.attempt, 2, 'exactly one new verification on resume');
  assert.equal(phases.filter((phase) => phase === 'repairing').length, 0, 'no repair turn');
  assert.match(
    resumed.timeline,
    /verification failed after 2 attempts \(repair budget exhausted\)/,
    resumed.timeline
  );
  ok('resume --max-repairs 0 spends one verification and no repair turn');
}

// 3. `resume --max-repairs 1`: exactly one repair turn, two new verifications.
{
  const { phases, deps } = phasesOf();
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => 'repairing',
      verdictProvider: failingProvider,
      ...deps(),
    },
    taskId,
    { maxRepairAttempts: 1 }
  );
  assert.equal(resumed.outcome, 'fail');
  assert.equal(resumed.snapshot.attempt, 4, 'two more verifications (seed 1 + 1 + 2)');
  assert.equal(phases.filter((phase) => phase === 'repairing').length, 1);
  assert.match(resumed.timeline, /after 4 attempts \(repair budget exhausted\)/, resumed.timeline);
  ok('resume --max-repairs 1 spends one repair turn and reports the ledger count');
}

// 4. `resume --max-turns 1`: the turn budget stops the run instead of a repair.
{
  const { phases, deps } = phasesOf();
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => 'one turn only',
      verdictProvider: failingProvider,
      ...deps(),
    },
    taskId,
    { maxRepairAttempts: DEFAULT_MAX_REPAIR_ATTEMPTS, maxTurns: 1 }
  );
  // A turn-budget stop is recorded as `task_failed`; the snapshot phase is
  // failed, so the outcome token is fail and the reason is the turn budget.
  assert.equal(resumed.outcome, 'fail');
  assert.match(resumed.timeline, /turn budget exhausted \(1 turns\)/, resumed.timeline);
  assert.equal(phases.filter((phase) => phase === 'repairing').length, 0);
  ok('resume --max-turns 1 stops on the turn budget');
}

// 5. Without the flags the fresh-run default still applies (constraint is opt-in).
{
  const id = await failedTask('default budget stays');
  const { phases, deps } = phasesOf();
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => 'repair',
      verdictProvider: failingProvider,
      ...deps(),
    },
    id
  );
  assert.equal(resumed.outcome, 'fail');
  assert.equal(
    phases.filter((phase) => phase === 'repairing').length,
    DEFAULT_MAX_REPAIR_ATTEMPTS,
    'the default repair budget is unchanged'
  );
  assert.equal(resumed.snapshot.attempt, DEFAULT_MAX_REPAIR_ATTEMPTS + 2);
  ok(`resume without flags keeps the default budget (${String(DEFAULT_MAX_REPAIR_ATTEMPTS)})`);
}

// 6. The CLI advertises the resume budget flags.
{
  const { renderTaskCliUsage } = await load('dist/cli/task-run.js');
  for (const usage of [renderTaskCliUsage(false), renderTaskCliUsage(true)]) {
    assert.match(usage, /resume <task_id>.*--max-repairs N.*--max-turns N/);
  }
  ok('resume usage documents --max-repairs / --max-turns');
}

console.log(`[resume-budget] ${checks}/${checks} checks passed`);
assert.ok(DEFAULT_MAX_TURNS >= 1);
