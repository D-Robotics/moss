#!/usr/bin/env node
/**
 * Super-agent tickets in the unified run ledger (offline, B149/B150).
 *
 * The ticket state machine has its own sqlite store; `moss runs` must still tell
 * one story, so a ticket that ends completed or blocked leaves a kind
 * `superagent` record with the ticket id, the native task, the acceptance
 * command, the worktree artifact and the retry next step.
 *
 * A scripted worker (the public `SuperagentWorker` seam) creates a real Task
 * Runtime contract in its worktree and reports ready/blocked, so this exercises
 * the runtime's real gate (native phase must be `accepted`, the oracle must
 * match, the acceptance command must pass) without a model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { createMossSuperagent } = await load('dist/core/superagent/runtime.js');
const { appendTaskEvent, createDraftTask } = await load('dist/core/task/task-store.js');
const { listRunRecords } = await load('dist/core/run-ledger.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[superagent-ledger] ok ${name}`);
};

const git = (cwd, args) =>
  captureProcess('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    timeoutMs: 30_000,
  });

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-superagent-ledger-'));
const ws = path.join(tmp, 'ws');
const configDir = path.join(tmp, 'config');
await fs.mkdir(ws, { recursive: true });
await fs.mkdir(configDir, { recursive: true });
try {
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'moss@example.com'],
    ['config', 'user.name', 'moss'],
    ['config', 'commit.gpgsign', 'false'],
  ]) {
    const result = await git(ws, args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  }
  await fs.writeFile(path.join(ws, 'README.md'), '# probe\n', 'utf8');
  for (const args of [
    ['add', 'README.md'],
    ['commit', '-qm', 'init'],
  ]) {
    const result = await git(ws, args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  }

  // Scripted worker: real contract + real accepted phase in its own worktree.
  let outcome = 'ready';
  const worker = {
    async run(request, _signal, onTask) {
      const contract = await createDraftTask(request.workspaceDir, 'probe goal', {
        acceptanceCommand: 'true',
      });
      const taskId = contract.taskId;
      onTask(taskId);
      await appendTaskEvent(request.workspaceDir, taskId, 'plan_ready', { steps: [] });
      await appendTaskEvent(request.workspaceDir, taskId, 'execution_started', {});
      await appendTaskEvent(request.workspaceDir, taskId, 'verification_started', {});
      if (outcome === 'ready') {
        await appendTaskEvent(request.workspaceDir, taskId, 'acceptance_pass', {
          detail: 'probe pass',
        });
      }
      return {
        state: outcome,
        summary: 'probe summary',
        readInputIds: request.inputs.map((input) => input.id),
        taskId,
      };
    },
    async deliver() {
      return [];
    },
  };
  const runtime = await createMossSuperagent({
    workspaceDir: ws,
    config: {
      acceptanceCommand: 'true',
      allowedActors: { local: ['operator'] },
      acceptMode: 'observe',
      rules: [],
      maxWorkers: 1,
      maxWallMs: 60_000,
    },
    worker,
    assess: async () => ({ kind: 'ignore', scope: 'probe', reason: 'probe', rules: [] }),
  });
  const receive = (id, text) =>
    runtime.receive({
      id,
      source: 'local',
      actor: 'operator',
      thread: id,
      text,
      human: true,
      addressed: true,
    });
  receive('evt_completed', 'create ok.txt');
  await runtime.work();
  const completed = runtime.tickets().find((ticket) => ticket.state === 'completed');
  assert.ok(completed, 'the scripted ready ticket should complete');

  outcome = 'blocked';
  receive('evt_blocked', 'second ticket');
  await runtime.work();
  const blocked = runtime.tickets().find((ticket) => ticket.state === 'blocked');
  assert.ok(blocked, 'the blocked ticket should stay blocked');
  await runtime.close();

  // 1. The ledger has one superagent record per ticket, with the ticket's truth.
  const records = await listRunRecords(ws);
  assert.equal(records.length, 2, `expected 2 records, got ${records.length}`);
  const byId = new Map(records.map((record) => [record.runId, record]));
  const done = byId.get(completed.id);
  assert.ok(done, `missing ledger record for ${completed.id}`);
  assert.equal(done.version, 1);
  assert.equal(done.kind, 'superagent');
  assert.equal(done.status, 'completed');
  assert.equal(done.exitCode, 0);
  assert.equal(done.goal, 'create ok.txt');
  assert.equal(done.acceptanceCommand, 'true');
  assert.equal(done.taskId, completed.taskId);
  assert.equal(done.next, 'moss superagent status');
  assert.equal(done.reason, undefined);
  assert.equal(done.artifacts?.superagentState, '.moss/superagent/state.sqlite');
  assert.match(done.artifacts?.workspace ?? '', /\.moss[\\/]worktrees[\\/]superagent-/);
  assert.ok(done.durationMs >= 0);

  const blockedRecord = byId.get(blocked.id);
  assert.equal(blockedRecord?.status, 'blocked');
  assert.equal(blockedRecord?.exitCode, 1);
  assert.match(blockedRecord?.next ?? '', new RegExp(`moss superagent retry ${blocked.id}`));
  assert.match(blockedRecord?.reason ?? '', /requires attention/);
  assert.equal(blockedRecord?.goal, 'second ticket');
  ok('one kind=superagent ledger record per ticket, completed and blocked');

  // 2. The CLI read path narrows to them by kind.
  const env = {
    ...process.env,
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_RDK_DOCS: '1',
    MOSS_NO_TUI: '1',
    MOSS_LANG: 'en',
  };
  const cli = (args) =>
    captureProcess(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
      cwd: ws,
      env,
      timeoutMs: 60_000,
    });
  const table = await cli(['runs', 'list', '--kind', 'superagent']);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /— kind superagent \(2\)/);
  assert.match(table.stdout, /superagent/);
  const json = await cli(['runs', 'list', '--kind', 'superagent', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.runs.map((run) => run.status).sort(), ['blocked', 'completed']);
  ok('moss runs --kind superagent lists both tickets');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[superagent-ledger] ${checks}/${checks} checks passed`);
