#!/usr/bin/env node
/**
 * Workflow run-record probe (offline, B138).
 *
 * `moss workflow run` is an autonomous run, so it must land in the unified ledger
 * with the completion-gate vocabulary — and its child `-p` steps must NOT each
 * add a chat row (the workflow row already covers them).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { aggregateWorkflowUsage, buildWorkflowRunRecord, workflowRunStatus } = await load(
  'dist/cli/workflow-run-record.js'
);
const { listRunRecords, writeRunRecord, readRunRecord } = await load('dist/core/run-ledger.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[workflow-run-record] ok ${name}`);
};

const state = (statuses) => ({
  schema: 'moss_workflow.v1',
  runId: 'wf_demo',
  name: 'demo',
  planFile: '/tmp/demo/plan.json',
  workspaceDir: '/tmp/demo',
  createdAt: new Date(1_000).toISOString(),
  updatedAt: new Date(2_000).toISOString(),
  concurrency: 1,
  steps: statuses.map((status, index) => ({ id: `s${index + 1}`, status })),
});

const base = { startedAt: 1_000, endedAt: 5_000 };

// 1. Status mapping: all passed / failed / blocked / leftover pending.
assert.equal(workflowRunStatus(state(['passed', 'passed'])), 'completed');
assert.equal(workflowRunStatus(state(['passed', 'failed'])), 'verify_failed');
assert.equal(workflowRunStatus(state(['passed', 'blocked'])), 'blocked');
assert.equal(workflowRunStatus(state(['passed', 'pending'])), 'incomplete');
ok('all-passed -> completed; failed -> verify_failed; blocked -> blocked; leftover -> incomplete');

// 2. A completed workflow: exit 0, no reason/next, state artifact.
{
  const record = buildWorkflowRunRecord({ state: state(['passed']), ...base });
  assert.equal(record.kind, 'workflow');
  assert.equal(record.status, 'completed');
  assert.equal(record.exitCode, 0);
  assert.equal(record.reason, undefined);
  assert.equal(record.next, undefined);
  assert.equal(record.durationMs, 4_000);
  assert.match(record.goal, /workflow "demo" — 1 step\(s\)/);
  assert.equal(record.artifacts.workflowState, '.moss/workflows/wf_demo/state.json');
  ok('a completed workflow record points at its state file and carries no failure fields');
}

// 3. A failed workflow: counts in the reason and a resume command.
{
  const record = buildWorkflowRunRecord({ state: state(['passed', 'failed']), ...base });
  assert.equal(record.status, 'verify_failed');
  assert.equal(record.exitCode, 1);
  assert.match(record.reason, /1 passed, 1 failed/);
  assert.match(record.reason, /plan\.json/);
  assert.equal(record.next, 'moss workflow resume wf_demo');
}
ok('a failed workflow records per-status counts and `moss workflow resume`');

// 4. Real CLI: `workflow run --mock` writes exactly one workflow row, no chat rows.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-workflow-ledger-'));
  const ws = path.join(tmp, 'ws');
  const configDir = path.join(tmp, 'config');
  await fs.mkdir(ws, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  try {
    const planPath = path.join(ws, 'plan.json');
    await fs.writeFile(
      planPath,
      `${JSON.stringify({
        name: 'mock-flow',
        concurrency: 1,
        steps: [{ id: 's1', task: 'say ok' }],
      })}\n`,
      'utf8'
    );
    const result = await captureProcess(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'workflow', 'run', planPath, '--mock'],
      {
        cwd: ws,
        env: {
          ...process.env,
          MOSS_CONFIG_DIR: configDir,
          MOSS_NO_RDK_DOCS: '1',
          MOSS_NO_TUI: '1',
          MOSS_LANG: 'en',
          MOSS_TRUST_WORKSPACE: '1',
        },
        timeoutMs: 120_000,
      }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const records = await listRunRecords(ws);
    assert.equal(records.length, 1, `expected one record, got ${records.length}`);
    assert.equal(records[0].kind, 'workflow');
    assert.equal(records[0].status, 'completed');
    assert.equal((await readRunRecord(ws, records[0].runId))?.exitCode, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  ok('`workflow run --mock` writes one workflow row and no per-step chat rows');
}

// 5. The shared ledger writer still accepts a workflow record among others.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-workflow-ledger2-'));
  const ws = path.join(tmp, 'ws');
  await fs.mkdir(ws, { recursive: true });
  try {
    await writeRunRecord(ws, buildWorkflowRunRecord({ state: state(['failed']), ...base }));
    const records = await listRunRecords(ws);
    assert.equal(records[0].kind, 'workflow');
    assert.equal(records[0].status, 'verify_failed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  ok('workflow records round-trip through the shared ledger');
}

// 6. B164: step usage (from each child's MOSS_USAGE_FILE) is summed into the
//    one workflow row; steps without numbers contribute nothing (never guessed).
{
  const withUsage = state(['passed', 'passed']);
  withUsage.steps[0].usage = {
    inputTokens: 10_000,
    outputTokens: 500,
    cacheReadTokens: 2_000,
    costUsd: 0.01,
  };
  withUsage.steps[1].usage = { inputTokens: 4_000, outputTokens: 100 };
  const totals = aggregateWorkflowUsage(withUsage);
  assert.deepEqual(totals, {
    inputTokens: 14_000,
    outputTokens: 600,
    cacheReadTokens: 2_000,
    costUsd: 0.01,
  });
  const record = buildWorkflowRunRecord({ state: withUsage, ...base });
  assert.deepEqual(record.usage, totals);
  assert.equal(aggregateWorkflowUsage(state(['passed'])), undefined);

  const partial = state(['passed', 'failed']);
  partial.steps[1].usage = { inputTokens: 7, outputTokens: 3 };
  assert.deepEqual(aggregateWorkflowUsage(partial), { inputTokens: 7, outputTokens: 3 });
}
ok('workflow usage sums across steps and omits steps without numbers');

console.log(`[workflow-run-record] ${checks}/${checks} checks passed`);
