#!/usr/bin/env node
/**
 * Acceptance-harness degradation probe (offline).
 *
 * A missing or timed-out acceptance command is not a test failure: no agent
 * turn can install a tool or raise the harness budget. The engine used to spend
 * every repair turn re-running the same broken command; it now blocks the task
 * with a named reason (Claude hook exit-code semantics, Cursor hook timeouts).
 * The real CLI run is proven separately — this locks the classification and the
 * engine short-circuit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { runAcceptanceCommandInWorkspace } = await load('dist/core/task/acceptance-command.js');
const { runTask } = await load('dist/core/task/task-engine.js');
const { recordGoalRun } = await load('dist/core/task-runtime/goal-runs.js');
const { formatGoalRunRows } = await load('dist/cli/task-list.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[acceptance-blocked] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-blocked-'));
const ws = path.join(tmp, 'ws');
await fs.mkdir(path.join(ws, '.git'), { recursive: true });
await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

const pass = await runAcceptanceCommandInWorkspace({ command: 'true' }, undefined, ws);
assert.equal(pass.passed, true);
assert.equal(pass.failureKind, undefined);
const nonzero = await runAcceptanceCommandInWorkspace({ command: 'exit 3' }, undefined, ws);
assert.equal(nonzero.passed, false);
assert.equal(nonzero.exitCode, 3);
assert.equal(nonzero.failureKind, 'exit_nonzero');
ok('a plain non-zero exit stays an ordinary failure (repair can help)');

const missing = await runAcceptanceCommandInWorkspace(
  { command: 'definitely-not-a-real-binary-xyz --version' },
  undefined,
  ws
);
assert.equal(missing.passed, false);
assert.equal(missing.exitCode, 127);
assert.equal(missing.failureKind, 'command_unavailable');
const slow = await runAcceptanceCommandInWorkspace(
  { command: 'sleep 5', timeoutMs: 250 },
  undefined,
  ws
);
assert.equal(slow.passed, false);
assert.equal(slow.timedOut, true);
assert.equal(slow.failureKind, 'timeout');
ok('missing command (127) and timeout are classified as harness failures');

const calls = [];
const phases = [];
const blockedResult = await runTask(
  {
    workspaceDir: ws,
    runTurn: async (prompt, phase) => {
      calls.push(phase);
      return 'done looking';
    },
    verdictProvider: {
      source: 'command',
      evaluate: async (taskId) => ({
        taskId,
        passed: false,
        source: 'command',
        detail: 'acceptance command is unavailable (exit 127)\ncommand not found',
        blocked: {
          kind: 'acceptance_command_unavailable',
          detail: 'acceptance command is unavailable (exit 127) — install it or correct --accept',
        },
      }),
    },
    maxRepairAttempts: 3,
    onProgress: (progress) => phases.push(progress.phase),
  },
  'write a file'
);
assert.equal(blockedResult.outcome, 'blocked');
assert.equal(blockedResult.snapshot.phase, 'blocked');
assert.match(blockedResult.snapshot.blockedReason ?? '', /acceptance command is unavailable/);
assert.equal(calls.filter((phase) => phase === 'repairing').length, 0, 'no repair turn was spent');
assert.ok(!phases.includes('repairing'));
ok('the engine blocks instead of burning repair turns on a broken harness');

const snapshots = blockedResult.snapshot;
assert.ok(blockedResult.timeline.includes('Blocked') || blockedResult.timeline.includes('阻塞'));
ok('the timeline names the blocked state');

// Contrast: an ordinary failing verdict still spends a repair turn, so the
// blocked path above is a real short-circuit and not a disabled repair loop.
const repairCalls = [];
const failing = await runTask(
  {
    workspaceDir: ws,
    runTurn: async (prompt, phase) => {
      repairCalls.push(phase);
      return 'tried';
    },
    verdictProvider: {
      source: 'command',
      evaluate: async (taskId) => ({
        taskId,
        passed: false,
        source: 'command',
        detail: 'acceptance command failed (exit 1)\nassertion failed',
      }),
    },
    maxRepairAttempts: 1,
  },
  'write another file'
);
assert.equal(failing.outcome, 'fail');
assert.ok(repairCalls.includes('repairing'), 'a genuine failure still gets repaired');
ok('an ordinary failure still enters repair (the short-circuit is specific)');

const row = await recordGoalRun(ws, {
  taskId: snapshots.taskId,
  goal: 'write a file',
  phase: snapshots.phase,
  outcome: blockedResult.outcome,
  attempts: snapshots.attempt,
  repairs: snapshots.repairs.length,
  turns: blockedResult.turns,
  startedAt: Date.now() - 2_000,
  blockedReason: snapshots.blockedReason,
});
const table = formatGoalRunRows([row], { limit: 5 });
assert.ok(table.some((line) => line.includes('blocked')));
assert.ok(
  table.some((line) => line.includes('↳') && line.includes('acceptance command is unavailable'))
);
ok('the goal rollup carries the blocked reason into `moss task list`');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[acceptance-blocked] ${checks}/6 checks passed`);
