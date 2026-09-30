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

import { runTasksCommand } from '../dist/cli/tasks-commands.js';
import { taskDefineTool, taskAcceptanceTool } from '../dist/tools/task-tools.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';

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
    { cwd: workspace, env: { ...process.env, MOSS_CONFIG_DIR: workspace } }
  );
  assert.match(cli.stdout, new RegExp(taskId));
});
