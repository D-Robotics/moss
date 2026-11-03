#!/usr/bin/env node
/**
 * `moss tasks` command — renders the robotics loop artifacts from a real
 * workspace (.moss/*.jsonl) across all subcommands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

import { runTasksCommand } from '../dist/cli/tasks-commands.js';
import { taskDefineTool, taskAcceptanceTool } from '../dist/tools/task-tools.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import { createDraftTask, appendTaskEvent } from '../dist/core/task/task-store.js';

const run = promisify(execFile);

function capture() {
  const out = [];
  const err = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => out.push(args.map(String).join(' '));
  console.error = (...args) => err.push(args.map(String).join(' '));
  return {
    text: () => out.join('\n'),
    errText: () => err.join('\n'),
    restore: () => {
      console.log = original.log;
      console.error = original.error;
    },
  };
}

test('moss tasks renders contracts, evidence, deployments, acceptance, device', async (t) => {
  const inheritedDeviceEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('MOSS_DEVICE_'))
  );
  for (const key of Object.keys(inheritedDeviceEnv)) delete process.env[key];
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MOSS_DEVICE_')) delete process.env[key];
    }
    Object.assign(process.env, inheritedDeviceEnv);
  });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tasks-cli-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = { workspaceDir: workspace, sessionKey: 'tasks-cli' };

  // Empty workspace: friendly guidance, no crash.
  let cap = capture();
  try {
    await runTasksCommand([], workspace);
    assert.match(cap.text(), /No task contracts/);
    await runTasksCommand(['device'], workspace);
    assert.match(cap.text(), /No device target configured/);
  } finally {
    cap.restore();
  }

  // Populate the loop artifacts through the real tools.
  const defined = await taskDefineTool.execute(
    {
      goal: 'person-stop behavior on RDK X5',
      acceptance_criteria: [
        { metric: 'device_reachable', expected: 'exists' },
        { metric: 'stop_distance_m', expected: '<=1' },
      ],
    },
    ctx
  );
  const taskId = /task_\w+/.exec(defined)[0];
  await recordEvidenceTool.execute(
    {
      metric: 'device_reachable',
      expected: 'exists',
      observed: 'connected',
      source: 'device_info',
      task_id: taskId,
    },
    ctx
  );
  await recordEvidenceTool.execute(
    {
      metric: 'stop_distance_m',
      expected: '<=1',
      observed: '0.9',
      source: 'device_exec',
      task_id: taskId,
    },
    ctx
  );
  await taskAcceptanceTool.execute({ task_id: taskId }, ctx);

  cap = capture();
  try {
    await runTasksCommand(['list'], workspace);
    let text = cap.text();
    assert.match(text, new RegExp(taskId));
    assert.match(text, /accepted/);
    assert.match(text, /evidence: 2 pass \/ 0 fail/);
    assert.match(text, /acceptance verdicts: 1/);

    cap = capture();
    await runTasksCommand(['evidence'], workspace);
    text = cap.text();
    assert.match(text, /device_reachable exists → connected/);
    assert.match(text, /stop_distance_m <=1 → 0\.9/);

    cap = capture();
    await runTasksCommand(['acceptance'], workspace);
    text = cap.text();
    assert.match(text, /PASS/);

    cap = capture();
    await runTasksCommand(['deployments'], workspace);
    assert.match(cap.text(), /No deployments recorded/);
  } finally {
    cap.restore();
  }

  // Device subcommand with a configured target.
  process.env.MOSS_DEVICE_HOST = '10.0.0.42';
  process.env.MOSS_DEVICE_USER = 'root';
  cap = capture();
  try {
    await runTasksCommand(['device'], workspace);
    assert.match(cap.text(), /linux-10\.0\.0\.42/);
    assert.match(cap.text(), /root@10\.0\.0\.42:22/);
  } finally {
    cap.restore();
    delete process.env.MOSS_DEVICE_HOST;
    delete process.env.MOSS_DEVICE_USER;
  }

  // Unknown subcommand → usage on stderr.
  cap = capture();
  try {
    await runTasksCommand(['bogus'], workspace);
    assert.match(cap.errText(), /Unknown tasks subcommand/);
  } finally {
    cap.restore();
  }

  // CLI-level smoke through the real binary.
  const cli = await run(
    process.execPath,
    [path.join(process.cwd(), 'dist', 'cli.js'), 'tasks', 'list'],
    {
      cwd: workspace,
      env: isolatedCliEnv({ overrides: { MOSS_CONFIG_DIR: workspace } }),
    }
  );
  assert.match(cli.stdout, new RegExp(taskId));
});

test('moss tasks list projects canonical status and ignores illegal event suffixes', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tasks-status-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const makeTask = async (goal, events = []) => {
    const task = await createDraftTask(workspace, goal);
    for (const [type, data] of events) {
      await appendTaskEvent(workspace, task.taskId, type, data);
    }
    return task;
  };

  const rows = [
    [await makeTask('draft task'), 'draft'],
    [await makeTask('active task', [['execution_started']]), 'active'],
    [
      await makeTask('accepted task', [
        ['execution_started'],
        ['verification_started'],
        ['acceptance_pass'],
      ]),
      'accepted',
    ],
    [
      await makeTask('blocked task', [
        ['execution_started'],
        ['blocked_on_user', { reason: 'user decision required' }],
      ]),
      'blocked',
    ],
    [
      await makeTask('failed task', [
        ['execution_started'],
        ['task_failed', { detail: 'verification failed' }],
      ]),
      'failed',
    ],
  ];
  const aborted = await makeTask('aborted task', [
    ['execution_started'],
    ['task_failed', { detail: 'aborted' }],
  ]);
  rows.push([aborted, 'aborted']);
  await fs.appendFile(
    path.join(workspace, '.moss', 'task-events.jsonl'),
    `${JSON.stringify({
      eventId: 'evt_illegal_terminal_suffix',
      taskId: aborted.taskId,
      type: 'task_failed',
      timestamp: Date.now(),
      phase: 'failed',
      data: { detail: 'illegal later failure' },
    })}\n`,
    'utf8'
  );

  const cap = capture();
  try {
    await runTasksCommand(['list'], workspace);
    const text = cap.text();
    for (const [task, status] of rows) {
      assert.match(text, new RegExp(`${task.taskId}\\s+${status}\\s`));
    }
  } finally {
    cap.restore();
  }
});

test('moss tasks list counts valid JSONL rows and excludes unconfirmed appends', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tasks-jsonl-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await createDraftTask(workspace, 'JSONL totals');
  const deployments = Array.from({ length: 60 }, (_, index) =>
    JSON.stringify({ deploymentId: `deployment_${index}` })
  );
  await fs.writeFile(
    path.join(workspace, '.moss', 'deployments.jsonl'),
    `${deployments.join('\n')}\nnot-json\n`,
    'utf8'
  );
  const confirmed = `${JSON.stringify({ verdict: 'pass' })}\n`;
  const unconfirmed = `${JSON.stringify({ verdict: 'fail' })}\n`;
  const acceptance = path.join(workspace, '.moss', 'acceptance.jsonl');
  await fs.writeFile(acceptance, confirmed + unconfirmed, 'utf8');
  await fs.writeFile(
    `${acceptance}.pending`,
    JSON.stringify({ originalSize: Buffer.byteLength(confirmed) }),
    'utf8'
  );

  const cap = capture();
  try {
    await runTasksCommand(['list'], workspace);
    assert.match(cap.text(), /deployments: 60 · acceptance verdicts: 1/);
  } finally {
    cap.restore();
  }
});
