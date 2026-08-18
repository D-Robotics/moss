#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutionGraphScheduler,
  InMemoryExecutionStore,
  writePathsOverlap,
} from '../dist/orchestration/index.js';

function createStore(nodes, options = {}) {
  const store = new InMemoryExecutionStore();
  store.create({
    id: 'graph',
    goal: 'Run a real dependency graph',
    nodes,
    policy: {
      maxConcurrency: options.maxConcurrency ?? 4,
      maxAttemptsPerNode: options.maxAttemptsPerNode ?? 3,
      strictCompletion: true,
    },
    budget: options.budget,
    now: 1,
  });
  return store;
}

test('scheduler runs independent nodes concurrently and preserves successful siblings', async () => {
  const store = createStore([
    { id: 'a', kind: 'analysis', title: 'A', dependencies: [] },
    { id: 'b', kind: 'analysis', title: 'B', dependencies: [] },
    { id: 'c', kind: 'verification', title: 'C', dependencies: ['a'] },
    { id: 'd', kind: 'verification', title: 'D', dependencies: ['b'] },
  ]);
  const scheduler = new ExecutionGraphScheduler(store);
  let active = 0;
  let peak = 0;

  const result = await scheduler.runAvailable('graph', async (node) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    if (node.id === 'b') {
      return { success: false, error: 'boom', failureFingerprint: 'boom:stable' };
    }
    return {
      success: true,
      evidence: [
        {
          id: `evidence-${node.id}`,
          kind: 'expert_claim',
          summary: `${node.id} completed`,
          createdAt: 10,
        },
      ],
    };
  });

  assert.equal(peak, 2, 'independent nodes should overlap in wall-clock execution');
  assert.deepEqual(result.startedNodeIds.sort(), ['a', 'b']);
  assert.equal(result.graph.nodes.a.status, 'succeeded');
  assert.equal(result.graph.nodes.b.status, 'failed');
  assert.equal(result.graph.nodes.c.status, 'ready');
  assert.equal(result.graph.nodes.d.status, 'blocked');
  assert.deepEqual(result.graph.nodes.a.evidenceIds, ['evidence-a']);
});

test('scheduler excludes overlapping write paths while admitting unrelated work', () => {
  const store = createStore([
    {
      id: 'root',
      kind: 'implementation',
      title: 'Root source',
      dependencies: [],
      writePaths: ['src'],
    },
    {
      id: 'nested',
      kind: 'implementation',
      title: 'Nested source',
      dependencies: [],
      writePaths: ['src\\feature'],
    },
    {
      id: 'docs',
      kind: 'implementation',
      title: 'Docs',
      dependencies: [],
      writePaths: ['docs/'],
    },
  ]);
  const scheduler = new ExecutionGraphScheduler(store);
  const graph = scheduler.reconcile('graph');
  assert.deepEqual(
    scheduler.selectRunnable(graph).map((node) => node.id),
    ['root', 'docs']
  );
  assert.equal(writePathsOverlap(['src'], ['src/feature/file.ts']), true);
  assert.equal(writePathsOverlap(['src2'], ['src/feature']), false);
  assert.throws(() => writePathsOverlap(['../escape'], ['docs']), /workspace-relative/);
});

test('three identical failure fingerprints block retry and propagate to dependents', () => {
  const store = createStore(
    [
      { id: 'work', kind: 'analysis', title: 'Work', dependencies: [] },
      { id: 'verify', kind: 'verification', title: 'Verify', dependencies: ['work'] },
    ],
    { maxAttemptsPerNode: 5 }
  );
  const scheduler = new ExecutionGraphScheduler(store);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    scheduler.reconcile('graph');
    scheduler.startNode('graph', 'work');
    scheduler.failNode('graph', 'work', {
      error: 'same failure',
      failureFingerprint: 'stable-failure',
    });
  }
  const graph = scheduler.reconcile('graph');
  assert.equal(graph.nodes.work.status, 'blocked');
  assert.equal(graph.nodes.work.consecutiveSameFailures, 3);
  assert.equal(graph.nodes.verify.status, 'blocked');
});

test('explicit budget exhaustion pauses rather than completes the graph', () => {
  const store = createStore([{ id: 'work', kind: 'analysis', title: 'Work', dependencies: [] }], {
    budget: { maxTokens: 100, usedTokens: 100 },
  });
  const scheduler = new ExecutionGraphScheduler(store);
  const graph = scheduler.reconcile('graph');
  assert.equal(graph.status, 'paused');
  assert.deepEqual(scheduler.selectRunnable(graph), []);
  assert.match(String(store.events('graph').at(-1)?.data.reason), /token budget exhausted/);
});

test('graph creation rejects dependency cycles before any work can run', () => {
  const store = new InMemoryExecutionStore();
  assert.throws(
    () =>
      store.create({
        id: 'cycle',
        goal: 'Never run a cycle',
        nodes: [
          { id: 'a', kind: 'analysis', title: 'A', dependencies: ['b'] },
          { id: 'b', kind: 'analysis', title: 'B', dependencies: ['a'] },
        ],
      }),
    /dependency cycle/
  );
});
