#!/usr/bin/env node
/**
 * Resume verify-first probe (offline, B116).
 *
 * `moss task resume` used to spend one full agent execution turn before it
 * looked at the workspace, so a corrected oracle (or work that was already
 * finished) still cost a model turn. A resume now verifies first and only buys
 * a turn when the check is still red. Fresh runs keep planning → execution →
 * verification ordering.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { runTask, resumeTask } = await load('dist/core/task/task-engine.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[resume-verify-first] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-resume-verify-first-'));
const ws = path.join(tmp, 'ws');
await fs.mkdir(path.join(ws, '.git'), { recursive: true });
await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

const red = {
  source: 'command',
  evaluate: async (taskId) => ({
    taskId,
    passed: false,
    source: 'command',
    detail: 'acceptance command failed (exit 1)\n',
  }),
};
const green = {
  source: 'command',
  evaluate: async (taskId) => ({
    taskId,
    passed: true,
    source: 'command',
    detail: 'acceptance command exited 0\n',
  }),
};
const blocked = {
  source: 'command',
  evaluate: async (taskId) => ({
    taskId,
    passed: false,
    source: 'command',
    detail: 'acceptance command unavailable\n',
    blocked: { kind: 'acceptance_command_unavailable', detail: 'command not found: nope-xyz' },
  }),
};

/** Seed a failed task (one verification) and return its id. */
async function failedTask(wsDir, goal) {
  const result = await runTask(
    {
      workspaceDir: wsDir,
      runTurn: async () => 'did something',
      verdictProvider: red,
      maxRepairAttempts: 0,
    },
    goal
  );
  assert.equal(result.outcome, 'fail');
  return result.snapshot.taskId;
}

// 1. Corrected oracle: a resume that already satisfies the oracle accepts with
//    ZERO agent turns and one new verification.
{
  const id = await failedTask(ws, 'oracle was wrong');
  let turns = 0;
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => {
        turns += 1;
        return 'should not run';
      },
      verdictProvider: green,
    },
    id
  );
  assert.equal(resumed.outcome, 'pass');
  assert.equal(turns, 0, 'a satisfied oracle must not buy an agent turn');
  assert.equal(resumed.snapshot.attempt, 2, 'exactly one new verification');
  assert.match(resumed.timeline, /Acceptance passed/, resumed.timeline);
  ok('resume with a passing workspace accepts with zero turns');
}

// 2. Still red + zero repair budget: fail after exactly one verification, no
//    execution turn at all.
{
  const id = await failedTask(ws, 'still red');
  let turns = 0;
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => {
        turns += 1;
        return 'should not run';
      },
      verdictProvider: red,
    },
    id,
    { maxRepairAttempts: 0 }
  );
  assert.equal(resumed.outcome, 'fail');
  assert.equal(turns, 0, 'no execution turn before the first verification');
  assert.equal(resumed.snapshot.attempt, 2);
  assert.match(resumed.timeline, /after 2 attempts \(repair budget exhausted\)/, resumed.timeline);
  ok('resume with a red workspace spends one verification and no turn');
}

// 3. A red first check still opens the repair path: the saved turn shows up in
//    the budget (1 repair + 1 execution instead of 2 executions + 1 repair).
{
  const id = await failedTask(ws, 'needs a repair');
  const phases = [];
  let turns = 0;
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => {
        turns += 1;
        return 'repairing';
      },
      verdictProvider: red,
      onProgress: (progress) => phases.push(progress.phase),
    },
    id,
    { maxRepairAttempts: 1 }
  );
  assert.equal(resumed.outcome, 'fail');
  assert.equal(turns, 2, 'one repair turn + one execution turn');
  assert.equal(phases.filter((phase) => phase === 'repairing').length, 1);
  assert.equal(phases.filter((phase) => phase === 'executing').length, 1);
  ok('a red first check opens exactly one repair + one execution turn');
}

// 4. A blocked resume stays blocked without spending a turn (the user must fix
//    the harness, not the agent).
{
  const id = await failedTask(ws, 'oracle unusable');
  let turns = 0;
  const resumed = await resumeTask(
    {
      workspaceDir: ws,
      runTurn: async () => {
        turns += 1;
        return 'should not run';
      },
      verdictProvider: blocked,
    },
    id
  );
  assert.equal(resumed.outcome, 'blocked');
  assert.equal(turns, 0);
  assert.match(resumed.timeline, /blocked|Blocked/i, resumed.timeline);
  ok('a blocked resume reports blocked with zero turns');
}

// 5. Fresh runs are unchanged: planning/execution happen before any verdict.
{
  const ws2 = path.join(tmp, 'ws2');
  await fs.mkdir(path.join(ws2, '.git'), { recursive: true });
  await fs.writeFile(path.join(ws2, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  let turns = 0;
  const result = await runTask(
    {
      workspaceDir: ws2,
      runTurn: async () => {
        turns += 1;
        return 'working';
      },
      verdictProvider: green,
    },
    'fresh goal'
  );
  assert.equal(result.outcome, 'pass');
  assert.ok(turns >= 1, 'a fresh run must still run the agent before accepting');
  ok('fresh runs keep the execution-first ordering');
}

console.log(`[resume-verify-first] ${checks}/${checks} checks passed`);
