#!/usr/bin/env node
/**
 * Evidence recorded without task_id must reach the contract it measures.
 *
 * `task_acceptance` defaults to the latest contract, but `record_evidence` did
 * not: a real PASS stored without task_id counted in the evidence store and
 * was invisible to acceptance, which answered "[NO EVIDENCE]" for the metric
 * the model had just measured. The same omission now attributes the row to the
 * latest contract when that contract's criteria name the metric, and says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import { taskDefineTool, taskAcceptanceTool } from '../dist/tools/task-tools.js';

function ctx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'test',
    abortSignal: new AbortController().signal,
    taskContracts: 'allow',
  };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evidence-task-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function defineTask(dir) {
  const out = await taskDefineTool.execute(
    {
      goal: 'camera pipeline stays up',
      acceptance_criteria: [
        { metric: 'camera_fps', expected: '>=30' },
        { metric: 'process_alive', expected: '==true' },
      ],
    },
    ctx(dir)
  );
  const taskId = out.match(/Task contract (task_\S+)/)?.[1];
  assert.ok(taskId, `task id not found in: ${out}`);
  return taskId;
}

test('evidence without task_id lands on the latest contract and acceptance passes', async (t) => {
  const dir = await workspace(t);
  const taskId = await defineTask(dir);

  const first = await recordEvidenceTool.execute(
    { metric: 'camera_fps', expected: '>=30', observed: '31.2', source: 'device_exec' },
    ctx(dir)
  );
  assert.match(first, new RegExp(`task: ${taskId} \\(latest contract; task_id omitted\\)`));
  await recordEvidenceTool.execute(
    { metric: 'process_alive', expected: '==true', observed: 'true', source: 'device_exec' },
    ctx(dir)
  );

  const verdict = await taskAcceptanceTool.execute({}, ctx(dir));
  assert.match(verdict, /Task acceptance .*: PASS/);
  assert.doesNotMatch(verdict, /NO EVIDENCE/);
});

test('a diagnostic metric no criterion names stays unlinked', async (t) => {
  const dir = await workspace(t);
  await defineTask(dir);
  const out = await recordEvidenceTool.execute(
    { metric: 'cpu_temp', expected: '<=80', observed: '55', source: 'device_temperature' },
    ctx(dir)
  );
  assert.doesNotMatch(out, /latest contract/);
  const rows = (await fs.readFile(path.join(dir, '.moss', 'evidence.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows.at(-1).metric, 'cpu_temp');
  assert.equal(rows.at(-1).taskId, undefined);
});

test('an unknown task_id is accepted but marked as not counting', async (t) => {
  const dir = await workspace(t);
  const taskId = await defineTask(dir);
  const out = await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '31',
      source: 'device_exec',
      task_id: 'task_nope',
    },
    ctx(dir)
  );
  assert.match(out, /^evidence ev_/);
  assert.match(out, /task: task_nope — no task contract has this id/);
  assert.match(out, /will not count toward task_acceptance/);
  // One turn fixes it: the row names the ids that do exist.
  assert.match(out, new RegExp(`known ids: .*${taskId}`));
});

test('an explicit task_id is still honored', async (t) => {
  const dir = await workspace(t);
  const taskId = await defineTask(dir);
  const out = await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '31',
      source: 'device_exec',
      task_id: taskId,
    },
    ctx(dir)
  );
  assert.match(out, new RegExp(`task=${taskId}`));
  assert.doesNotMatch(out, /latest contract/);
});
