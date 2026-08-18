#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InMemoryExecutionStore, LegacyExecutionImporter } from '../dist/orchestration/index.js';

test('goal, TaskFrame, Plan, and Loop checkpoints import paused without rewriting originals', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-legacy-import-'));
  const fixtures = [
    ['goal', { sessionKey: 's1', objective: 'Goal', status: 'active' }],
    [
      'task-frame',
      { sessionKey: 's2', goal: 'Frame', completedSteps: ['done'], currentStep: 'next' },
    ],
    [
      'plan',
      {
        id: 'p1',
        goal: 'Plan',
        steps: [
          { step: 1, description: 'A', dependsOn: [] },
          { step: 2, description: 'B', dependsOn: [1], writePaths: ['src'] },
        ],
      },
    ],
    ['loop', { sessionKey: 's3', prompt: 'Loop', currentIteration: 2, status: 'paused' }],
  ];
  const store = new InMemoryExecutionStore();
  const importer = new LegacyExecutionImporter(store);
  try {
    for (const [kind, state] of fixtures) {
      const sourcePath = path.join(temp, `${kind}.json`);
      const original = `${JSON.stringify(state)}\n`;
      fs.writeFileSync(sourcePath, original);
      const graph = importer.import({ kind, sourcePath, state });
      assert.equal(graph.status, 'paused_recovered');
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
      assert.equal(fs.existsSync(`${sourcePath}.execution-graph-migration-v1.json`), true);
      assert.equal(importer.import({ kind, sourcePath, state }).id, graph.id);
    }
    const plan = store.list().find((graph) => graph.goal === 'Plan');
    assert.deepEqual(plan.nodes['step-2'].dependencies, ['step-1']);
    assert.deepEqual(plan.nodes['step-2'].writePaths, ['src']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('completed legacy state becomes needs-evidence blocked instead of verified', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-legacy-complete-'));
  const sourcePath = path.join(temp, 'loop.json');
  fs.writeFileSync(sourcePath, '{}\n');
  try {
    const graph = new LegacyExecutionImporter(new InMemoryExecutionStore()).import({
      kind: 'loop',
      sourcePath,
      state: { sessionKey: 'done', prompt: 'claimed done', status: 'completed' },
    });
    assert.equal(graph.status, 'blocked');
    assert.equal(graph.verification, undefined);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a TaskFrame marker resolves its original graph when the next run id changes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-legacy-frame-repeat-'));
  const sourcePath = path.join(temp, 'task-frame.json');
  const store = new InMemoryExecutionStore();
  const importer = new LegacyExecutionImporter(store);
  try {
    const first = importer.import({
      kind: 'task-frame',
      sourcePath,
      state: { sessionKey: 'same-session', runId: 'first-run', currentStep: 'one' },
    });
    const repeated = importer.import({
      kind: 'task-frame',
      sourcePath,
      state: { sessionKey: 'same-session', runId: 'second-run', currentStep: 'two' },
    });
    assert.equal(repeated.id, first.id);
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
