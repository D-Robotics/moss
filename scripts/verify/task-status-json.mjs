#!/usr/bin/env node
/**
 * `moss task status --json` probe (offline).
 *
 * `task status` was human-only while `task list` and `loop show` already had
 * `--json`, so CI had to parse prose. This probe builds real task artifacts
 * through the dist core APIs (a failed task with a plan + recorded failure and
 * a blocked task), spawns the real CLI and locks the contract:
 *
 * - `task status <id> --json` prints exactly one pretty JSON object (no prose)
 *   with the documented keys/order and raw (non-localized) values;
 * - `status` is the three-way completed/live/blocked label derived from `statusView`;
 * - `resumable` is true for failed/blocked, `lastFailure` carries the recorded
 *   symptom, `engineFailure` the `task_failed` detail, `blockedReason` only on
 *   blocked rows, and `acceptanceCommand` the persisted oracle;
 * - plan step order/status and the timeline lines survive;
 * - a workspace with no task prints `null` and exits 0;
 * - the human view is unchanged (TASK/PHASE lines, "No tasks" for an unknown
 *   id) and `--json` in either position means the same thing.
 *
 * The real deepseek-flash run is proven separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist', 'cli.js');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { createDraftTask, appendTaskEvent, recordFailure, recordRepair } = await load(
  'dist/core/task/task-store.js'
);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-status-json-'));
const home = path.join(tmp, 'home');
const configDir = path.join(tmp, 'config');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(configDir, { recursive: true });
// `task status` never calls a model, but the CLI's preflight requires a
// resolved provider/model. A fake local config keeps the probe hermetic.
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
  MOSS_LANG: 'en',
  LC_ALL: 'C',
};

const workspace = await makeWorkspace('workspace');
const emptyWorkspace = await makeWorkspace('empty-workspace');
/** The workspace each spawn runs in; only check 4 switches it to the empty one. */
let cwd = workspace;

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[task-status-json] ok ${name}`);
}

async function runCli(args, env = {}) {
  const result = await captureProcess(process.execPath, [cli, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    timeoutMs: 60_000,
  });
  assert.equal(result.timedOut, false, `${args.join(' ')} timed out`);
  return result;
}

async function runStatusJson(args, env = {}) {
  const result = await runCli(args, env);
  assert.equal(
    result.status,
    0,
    `task status exited ${String(result.status)}: ${result.stderr.slice(-600)}`
  );
  assert.doesNotMatch(result.stdout, /^TASK\s/m, 'JSON output must not print the human TASK line');
  assert.doesNotMatch(
    result.stdout,
    /^PHASE\s/m,
    'JSON output must not print the human PHASE line'
  );
  return JSON.parse(result.stdout);
}

async function runStatusHuman(args, env = {}) {
  const result = await runCli(args, env);
  assert.equal(
    result.status,
    0,
    `task status exited ${String(result.status)}: ${result.stderr.slice(-600)}`
  );
  return result.stdout;
}

/** A workspace the task store accepts as a git work tree (runtime artifacts are git-ignored). */
async function makeWorkspace(name) {
  const dir = path.join(tmp, name);
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return dir;
}

const failed = await createDraftTask(workspace, 'Create note.txt containing hi', {
  acceptanceCommand: 'false',
});
await appendTaskEvent(workspace, failed.taskId, 'planning_started');
await appendTaskEvent(workspace, failed.taskId, 'plan_ready');
await appendTaskEvent(workspace, failed.taskId, 'note', {
  steps: [
    { stepId: 'step-1', title: 'Create note.txt', status: 'done' },
    { stepId: 'step-2', title: 'Verify the content', status: 'failed' },
    { stepId: 'step-3', title: 'Report the result', status: 'skipped' },
  ],
});
await appendTaskEvent(workspace, failed.taskId, 'execution_started');
await appendTaskEvent(workspace, failed.taskId, 'verification_started');
const failure = await recordFailure(workspace, {
  taskId: failed.taskId,
  stage: 'verifying',
  symptom: 'acceptance command `false` exited 1',
  attempt: 1,
  resolved: false,
});
await recordRepair(workspace, {
  taskId: failed.taskId,
  failureId: failure.failureId,
  action: 'rewrote the deliverable',
});
await appendTaskEvent(workspace, failed.taskId, 'task_failed', {
  detail: 'acceptance command failed (exit 1)',
});

const blocked = await createDraftTask(workspace, 'Probe the camera feed', {
  acceptanceCommand: 'test -f camera.json',
});
await appendTaskEvent(workspace, blocked.taskId, 'planning_started');
await appendTaskEvent(workspace, blocked.taskId, 'plan_ready');
await appendTaskEvent(workspace, blocked.taskId, 'execution_started');
await appendTaskEvent(workspace, blocked.taskId, 'blocked_on_user', {
  reason: 'needs device access',
});

// 1. One JSON object, documented keys in order, raw values, no prose.
const failedJson = await runStatusJson(['task', 'status', failed.taskId, '--json']);
assert.deepEqual(Object.keys(failedJson), [
  'taskId',
  'goal',
  'phase',
  'status',
  'attempt',
  'repairs',
  'failures',
  'evidence',
  'resumable',
  'acceptanceCommand',
  'lastFailure',
  'blockedReason',
  'engineFailure',
  'plan',
  'timeline',
]);
assert.equal(failedJson.taskId, failed.taskId);
assert.equal(failedJson.goal, 'Create note.txt containing hi');
assert.equal(failedJson.phase, 'failed');
assert.equal(failedJson.status, 'completed');
assert.equal(failedJson.attempt, 1);
assert.equal(failedJson.repairs, 1);
assert.equal(failedJson.failures, 1);
assert.equal(failedJson.evidence, 0);
assert.equal(failedJson.resumable, true);
assert.equal(failedJson.acceptanceCommand, 'false');
assert.deepEqual(failedJson.lastFailure, {
  stage: 'verifying',
  symptom: 'acceptance command `false` exited 1',
  resolved: false,
});
assert.equal(failedJson.blockedReason, null);
assert.equal(failedJson.engineFailure, 'acceptance command failed (exit 1)');
assert.ok(Array.isArray(failedJson.timeline), 'timeline must be an array');
assert.ok(failedJson.timeline.length > 0, 'timeline must carry the recorded events');
assert.ok(
  failedJson.timeline.every((line) => typeof line === 'string'),
  'every timeline entry is a formatted line'
);
ok('task status --json prints one object with the documented keys and raw values');

// 2. Plan order and status survive the projection.
assert.deepEqual(failedJson.plan, [
  { stepId: 'step-1', title: 'Create note.txt', status: 'done' },
  { stepId: 'step-2', title: 'Verify the content', status: 'failed' },
  { stepId: 'step-3', title: 'Report the result', status: 'skipped' },
]);
ok('plan order/status is preserved');

// 3. A blocked task reports its reason and stays resumable.
const blockedJson = await runStatusJson(['task', 'status', blocked.taskId, '--json']);
assert.equal(blockedJson.phase, 'blocked');
assert.equal(blockedJson.status, 'blocked');
assert.equal(blockedJson.resumable, true);
assert.equal(blockedJson.blockedReason, 'needs device access');
assert.equal(blockedJson.acceptanceCommand, 'test -f camera.json');
assert.equal(blockedJson.lastFailure, null);
assert.equal(blockedJson.engineFailure, null);
assert.equal(blockedJson.failures, 0);
ok('a blocked task exposes blockedReason and no failure/engine detail');

const live = await createDraftTask(workspace, 'Inspect the deployment log');
await appendTaskEvent(workspace, live.taskId, 'planning_started');
await appendTaskEvent(workspace, live.taskId, 'plan_ready');
await appendTaskEvent(workspace, live.taskId, 'execution_started');

// 4. The three-way `status` label: a live (executing) task reports "live".
const liveJson = await runStatusJson(['task', 'status', live.taskId, '--json']);
assert.equal(liveJson.phase, 'executing');
assert.equal(liveJson.status, 'live');
assert.equal(liveJson.resumable, true);
assert.equal(liveJson.blockedReason, null);
assert.equal(liveJson.lastFailure, null);
assert.equal(liveJson.engineFailure, null);
ok('a live task reports status live and no blocked/failure fields');

// 5. A workspace with no task prints null (not a prose line).
cwd = emptyWorkspace;
const emptyJson = await runStatusJson(['task', 'status', '--json']);
assert.equal(emptyJson, null);
assert.equal(
  (await runStatusHuman(['task', 'status'])).trim(),
  'No tasks in this workspace. Start one: moss task run <goal>',
  'the human view keeps its no-task line'
);
cwd = workspace;
ok('no task prints null with --json and the human line without it');

// 6. Human output is unchanged; an unknown id keeps today's behaviour.
// (The "no task" line above also covers the unknown-id message: both resolve
// to a null snapshot, so --json must print null there too.)
const unknownJson = await runStatusJson(['task', 'status', 'task_does_not_exist', '--json']);
assert.equal(unknownJson, null);
assert.equal(
  (await runStatusHuman(['task', 'status', 'task_does_not_exist'])).trim(),
  'No tasks in this workspace. Start one: moss task run <goal>'
);
const human = await runStatusHuman(['task', 'status', failed.taskId]);
assert.match(human, /^TASK {6}task_/m, 'the human TASK line survives');
assert.match(
  human,
  /^PHASE {5}failed \(completed · fail\)$/m,
  'the human PHASE/status line survives'
);
assert.match(human, /^ATTEMPTS {2}1 · repairs 1 · failures 1 · evidence 0$/m);
assert.throws(() => JSON.parse(human), /Unexpected|JSON/, 'human output is still not JSON');
ok('human output keeps TASK/PHASE/ATTEMPTS and unknown ids keep the human message');

// 7. `--json` before or after the subcommand means the same object.
const afterJson = await runStatusJson(['task', 'status', failed.taskId, '--json']);
const beforeJson = await runStatusJson(['task', '--json', 'status', failed.taskId]);
const topLevelJson = await runStatusJson(['--json', 'task', 'status', failed.taskId]);
assert.deepEqual(afterJson, beforeJson, 'the flag position must not change the object');
assert.deepEqual(afterJson, topLevelJson, 'the top-level --json is honoured');
ok('--json before the subcommand, after it, and at the top level all print the same object');

// 8. B253: `latest` works for status and timeline (the newest task is the live
// one created last), matching runs/loop/workflow read paths.
const latestJson = await runStatusJson(['task', 'status', 'latest', '--json']);
assert.equal(latestJson.taskId, live.taskId);
const latestTimeline = await runCli(['task', 'timeline', 'latest']);
assert.equal(latestTimeline.status, 0, latestTimeline.stderr);
assert.match(latestTimeline.stdout, /Task created/);
ok('task status/timeline accept `latest`');

console.log(`[task-status-json] ${String(checks)} checks passed`);
