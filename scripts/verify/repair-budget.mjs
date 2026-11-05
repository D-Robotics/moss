#!/usr/bin/env node
/**
 * Repair-budget honesty probe (offline).
 *
 * `--max-repairs 0` means "no engine repair turn": one verification, then an
 * honest FAIL. The bug this locks: the agent may verify inside its own turn
 * (`/task verify`-style tool), which appends a `verification_started` of its
 * own. The engine then re-verifies, so `.moss/goals.jsonl` legitimately says
 * `attempts: 2`, while the failure line said "after 1 attempts" — a
 * user-visible contradiction (`task list` vs the run summary) and bad grammar.
 * The failure line now reports the number the ledger shows, and the CLI help
 * defaults are derived from the engine constants instead of a stale literal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { runTask, summarizeTaskRun, DEFAULT_MAX_REPAIR_ATTEMPTS, DEFAULT_MAX_TURNS } = await load(
  'dist/core/task/task-engine.js'
);
const { emitAcceptanceLifecycle, localizeTaskDetail } = await load('dist/core/task/task-store.js');
const { renderTaskCliUsage } = await load('dist/cli/task-run.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[repair-budget] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-repair-budget-'));
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

/**
 * Run one failing task. `selfVerify` models the agent calling a verification
 * tool during its execution turn (the real behaviour behind att:2 rep:1).
 */
async function runFailing({ maxRepairAttempts, selfVerify = false, goal, maxTurns }) {
  const phases = [];
  const turnPhases = [];
  let taskId;
  const result = await runTask(
    {
      workspaceDir: ws,
      runTurn: async (_prompt, phase) => {
        turnPhases.push(phase);
        if (selfVerify && phase === 'executing' && taskId) {
          await emitAcceptanceLifecycle(ws, taskId, false, 'acceptance command failed (exit 1)\n');
        }
        return 'did something';
      },
      verdictProvider: failingProvider,
      maxRepairAttempts,
      ...(maxTurns === undefined ? {} : { maxTurns }),
      onProgress: (progress) => {
        taskId ??= progress.taskId;
        phases.push(progress.phase);
      },
    },
    goal
  );
  const events = await load('dist/core/task/task-store.js').then((m) =>
    m.listTaskEvents(ws, result.snapshot.taskId)
  );
  const failure = events.findLast((event) => event.type === 'task_failed');
  return { result, phases, turnPhases, detail: String(failure?.data?.detail ?? '') };
}

const attemptFrom = (detail) => Number(/after (\d+) attempts? \(/.exec(detail)?.[1]);

// 1. `--max-repairs 0`: one verification, no repair turn, honest singular line.
{
  const run = await runFailing({ maxRepairAttempts: 0, goal: 'zero repairs' });
  assert.equal(run.result.outcome, 'fail');
  assert.equal(run.result.snapshot.attempt, 1);
  assert.equal(run.turnPhases.filter((phase) => phase === 'repairing').length, 0);
  assert.equal(run.detail, 'verification failed after 1 attempt (repair budget exhausted)');
  assert.equal(attemptFrom(run.detail), run.result.snapshot.attempt);
  assert.equal(localizeTaskDetail(run.detail, true), '验证失败，已尝试 1 次（修复次数已用尽）');
  ok('--max-repairs 0 stops after one verification with singular grammar (zh kept)');
}

// 2. Agent-initiated verification: the failure line must match the ledger count.
{
  const run = await runFailing({ maxRepairAttempts: 0, selfVerify: true, goal: 'self verified' });
  assert.equal(run.result.outcome, 'fail');
  assert.equal(run.result.snapshot.attempt, 2, 'agent verification + engine re-verification');
  assert.equal(run.turnPhases.filter((phase) => phase === 'repairing').length, 0);
  assert.equal(run.detail, 'verification failed after 2 attempts (repair budget exhausted)');
  assert.equal(attemptFrom(run.detail), run.result.snapshot.attempt);
  // The user-facing summary prints the same attempt count as the ledger and
  // the timeline, so `task run`, `task status` and `task list` agree.
  const summary = summarizeTaskRun(run.result, 'en');
  assert.match(summary, /attempts: 2\b/, summary);
  assert.ok(!/attempts: 1\b/.test(summary), summary);
  assert.ok(!summary.includes('after 1 attempts'));
  ok('an agent-verified in-turn attempt is counted honestly (no "1 attempts" lie)');
}

// 3. Larger budgets still spend exactly N repair turns and N+1 verifications.
for (const budget of [1, 2]) {
  const run = await runFailing({ maxRepairAttempts: budget, goal: `repair ${budget}` });
  assert.equal(run.result.outcome, 'fail');
  assert.equal(run.result.snapshot.attempt, budget + 1);
  assert.equal(run.turnPhases.filter((phase) => phase === 'repairing').length, budget);
  assert.equal(attemptFrom(run.detail), budget + 1);
  assert.ok(!run.detail.includes('1 attempts'), 'plural grammar');
}
ok('max-repairs N spends N repair turns and reports N+1 attempts');

// 3b. B126: the turn budget must count EXECUTED turns. Checking after the
// increment made `--max-turns 1` report `turns: 2` in the summary/rollup for a
// run that only spent the planning turn.
{
  const run = await runFailing({
    maxRepairAttempts: DEFAULT_MAX_REPAIR_ATTEMPTS,
    goal: 'one turn',
    maxTurns: 1,
  });
  assert.equal(run.result.outcome, 'fail');
  assert.equal(run.detail, 'turn budget exhausted (1 turns)');
  assert.equal(run.result.turns, 1, 'only the planning turn executed');
  assert.equal(run.turnPhases.filter((phase) => phase === 'executing').length, 0);
  assert.equal(run.turnPhases.filter((phase) => phase === 'repairing').length, 0);
  const summary = summarizeTaskRun(run.result, 'en');
  assert.match(summary, /turns: 1\b/, summary);
  assert.ok(!/turns: 2\b/.test(summary), summary);
  ok('a turn-budget stop reports the executed turns, not the refused one');
}

{
  const run = await runFailing({
    maxRepairAttempts: DEFAULT_MAX_REPAIR_ATTEMPTS,
    goal: 'two turns',
    maxTurns: 2,
  });
  assert.equal(run.result.turns, 2, 'planning + one execution turn');
  assert.equal(run.turnPhases.filter((phase) => phase === 'executing').length, 1);
  assert.equal(run.turnPhases.filter((phase) => phase === 'repairing').length, 0);
  assert.equal(run.detail, 'turn budget exhausted (2 turns)');
  assert.match(summarizeTaskRun(run.result, 'en'), /turns: 2\b/);
  ok('a two-turn budget spends planning + one execution turn and says so');
}

// 4. CLI help defaults come from the engine constants, not stale literals.
{
  const en = renderTaskCliUsage(false);
  const zh = renderTaskCliUsage(true);
  const num = (text) => Number(/(?:default|默认) (\d+)/.exec(text)?.[1]);
  assert.ok(
    en.includes(`--max-repairs N`) && num(en) === DEFAULT_MAX_REPAIR_ATTEMPTS,
    `en help repair default should be ${String(DEFAULT_MAX_REPAIR_ATTEMPTS)}`
  );
  assert.ok(zh.includes(`（默认 ${String(DEFAULT_MAX_REPAIR_ATTEMPTS)}）`));
  assert.ok(
    en.includes(`(default ${String(DEFAULT_MAX_TURNS)})`) &&
      zh.includes(`（默认 ${String(DEFAULT_MAX_TURNS)}）`)
  );
  ok(
    `help defaults match the engine (repairs ${String(DEFAULT_MAX_REPAIR_ATTEMPTS)}, turns ${String(DEFAULT_MAX_TURNS)})`
  );
}

console.log(`[repair-budget] ${checks}/${checks} checks passed`);
