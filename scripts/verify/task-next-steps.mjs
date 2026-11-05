#!/usr/bin/env node
/**
 * Run-summary next-step probe (offline, B119).
 *
 * A non-interactive `moss task run/resume` prints the summary and nothing else:
 * a bare "FAIL" with counts left the user to dig through `.moss/` for the reason
 * and the retry command. Cursor/Claude always print a next step. This locks the
 * reason line and the exact continuation command for every non-pass outcome.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { runTask, summarizeTaskRun } = await load('dist/core/task/task-engine.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[task-next-steps] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-next-steps-'));
async function workspace(name) {
  const dir = path.join(tmp, name);
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return dir;
}

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
const run = (ws, provider, extra = {}) =>
  runTask(
    { workspaceDir: ws, runTurn: async () => 'working', verdictProvider: provider, ...extra },
    'goal'
  );

// 1. Repair-budget failure: reason + the exact resume command with a larger budget.
{
  const result = await run(await workspace('fail'), red, { maxRepairAttempts: 0 });
  assert.equal(result.outcome, 'fail');
  assert.equal(
    result.failureDetail,
    'verification failed after 1 attempt (repair budget exhausted)'
  );
  const summary = summarizeTaskRun(result, 'en');
  assert.match(summary, /failed: verification failed after 1 attempt \(repair budget exhausted\)/);
  assert.match(
    summary,
    new RegExp(`next: moss task resume ${result.snapshot.taskId} --max-repairs 1`)
  );
  assert.match(summarizeTaskRun(result, 'zh'), /失败：验证失败，已尝试 1 次/);
  assert.match(summarizeTaskRun(result, 'zh'), /下一步：moss task resume /);
  ok('a repair-budget failure names the reason and the retry command');
}

// 2. Turn-budget failure: suggest a larger turn budget, derived from the cap.
{
  const result = await run(await workspace('turn-budget'), red, { maxTurns: 2 });
  assert.equal(result.outcome, 'fail');
  assert.match(result.failureDetail ?? '', /turn budget exhausted \(2 turns\)/);
  const summary = summarizeTaskRun(result, 'en');
  assert.match(summary, /failed: turn budget exhausted \(2 turns\)/);
  assert.match(summary, /--max-turns 4\b/, summary);
  ok('a turn-budget failure suggests doubling the cap');
}

// 3. Blocked: the harness reason is printed, and the fix is the oracle flag.
{
  const result = await run(await workspace('blocked'), blocked);
  assert.equal(result.outcome, 'blocked');
  assert.ok(result.blockedReason?.includes('command not found'));
  const summary = summarizeTaskRun(result, 'en');
  assert.match(summary, /blocked: .*command not found/);
  assert.match(summary, /next: moss task resume \S+ --accept "<corrected command>"/);
  assert.match(
    summarizeTaskRun(result, 'zh'),
    /下一步：moss task resume .* --accept "<修正后的验收命令>"/
  );
  ok('a blocked run names the harness gap and the correction command');
}

// 4. Esc/aborted keeps the interactive hint and gains the headless one.
{
  const controller = new AbortController();
  controller.abort();
  const ws = await workspace('aborted');
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn: async () => 'working',
      verdictProvider: green,
      signal: controller.signal,
    },
    'aborted goal'
  );
  assert.equal(result.outcome, 'aborted');
  const summary = summarizeTaskRun(result, 'en');
  assert.match(summary, /^\/run resume$/m);
  assert.match(summary, /next: moss task resume /);
  ok('an aborted run keeps /goal resume and adds the headless command');
}

// 5. A pass prints no advice at all.
{
  const result = await run(await workspace('pass'), green);
  assert.equal(result.outcome, 'pass');
  const summary = summarizeTaskRun(result, 'en');
  assert.ok(!/\n(next|failed|blocked): /.test(summary), summary);
  ok('a passing summary carries no next-step noise');
}

// 6. The failure fields never leak into a passing result.
{
  const result = await run(await workspace('pass2'), green);
  assert.equal(result.failureDetail, undefined);
  assert.equal(result.blockedReason, undefined);
  ok('run results only carry failure fields when they apply');
}

console.log(`[task-next-steps] ${checks}/${checks} checks passed`);
