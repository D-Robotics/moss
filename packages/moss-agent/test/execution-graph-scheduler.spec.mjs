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
  const graph = store.create({
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
  store.append('graph', { expectedRevision: graph.revision, type: 'graph.resumed' });
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

test('scheduler holds and renews one fenced owner lease for the complete execution cycle', async () => {
  let clock = 0;
  const store = new InMemoryExecutionStore({ now: () => clock });
  const graph = store.create({
    id: 'graph',
    goal: 'renew deterministically',
    nodes: [{ id: 'work', kind: 'analysis', title: 'Work', dependencies: [] }],
  });
  store.append('graph', { expectedRevision: graph.revision, type: 'graph.resumed' });
  const first = new ExecutionGraphScheduler(store, {
    ownerId: 'scheduler-1',
    leaseTtlMs: 30,
    leaseRenewIntervalMs: 5,
  });
  const second = new ExecutionGraphScheduler(store, { ownerId: 'scheduler-2' });
  let releaseWork;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const firstRun = first.runAvailable('graph', async () => {
    markStarted();
    await new Promise((resolve) => {
      releaseWork = resolve;
    });
    return { success: true };
  });
  await started;
  clock = 20;
  await new Promise((resolve) => setTimeout(resolve, 12));
  clock = 35;
  await assert.rejects(
    () => second.runAvailable('graph', async () => ({ success: true })),
    (error) => error?.code === 'EXECUTION_LEASE_HELD'
  );
  releaseWork();
  const result = await firstRun;
  assert.equal(result.graph.nodes.work.status, 'succeeded');
});

test('a user stop aborts in-flight executor context and cannot be overwritten by completion', async () => {
  let clock = 0;
  const store = new InMemoryExecutionStore({ now: () => clock });
  let graph = store.create({
    id: 'graph',
    goal: 'stop an in-flight execution',
    nodes: [{ id: 'work', kind: 'analysis', title: 'Work', dependencies: [] }],
  });
  store.append('graph', { expectedRevision: graph.revision, type: 'graph.resumed' });
  const scheduler = new ExecutionGraphScheduler(store, {
    ownerId: 'scheduler',
    leaseTtlMs: 30,
    leaseRenewIntervalMs: 5,
  });
  let observedAbort = false;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const running = scheduler.runAvailable('graph', async (_node, _graph, context) => {
    markStarted();
    await new Promise((resolve) => {
      context.signal.addEventListener(
        'abort',
        () => {
          observedAbort = true;
          resolve();
        },
        { once: true }
      );
    });
    return { success: true };
  });
  await started;
  clock = 31;
  const current = store.load('graph');
  store.append('graph', {
    expectedRevision: current.revision,
    type: 'graph.cancelled',
    data: { requestedBy: 'user' },
  });
  const result = await running;
  assert.equal(observedAbort, true);
  assert.equal(result.graph.status, 'cancelled');
  assert.equal(result.graph.nodes.work.status, 'cancelled');
  assert.equal(
    store.events('graph').some((event) => event.type === 'node.succeeded'),
    false
  );
});

test('paused, recovered, and cancelled graphs cannot be executed or revived by the scheduler', async () => {
  for (const status of ['paused', 'paused_recovered', 'cancelled']) {
    const store = new InMemoryExecutionStore();
    let graph = store.create({
      id: `graph-${status}`,
      goal: status,
      nodes: [{ id: 'work', kind: 'analysis', title: 'Work', dependencies: [] }],
    });
    if (status === 'paused_recovered') {
      graph = store.append(graph.id, {
        expectedRevision: graph.revision,
        type: 'graph.recovered',
        data: {
          recovery: {
            recoveredAt: 2,
            requiresUserResume: true,
            interruptedNodeIds: [],
            blockedMutationNodeIds: [],
          },
        },
      });
    } else if (status === 'cancelled') {
      graph = store.append(graph.id, {
        expectedRevision: graph.revision,
        type: 'graph.cancelled',
      });
    }
    let calls = 0;
    const result = await new ExecutionGraphScheduler(store).runAvailable(graph.id, async () => {
      calls += 1;
      return { success: true };
    });
    assert.equal(calls, 0, `${status} graph executed work`);
    assert.equal(result.graph.status, status);
    if (status === 'cancelled') {
      assert.throws(
        () =>
          store.append(graph.id, {
            expectedRevision: result.graph.revision,
            type: 'graph.resumed',
          }),
        /cannot transition from cancelled/
      );
    }
  }
});

test('scheduler excludes overlapping write paths while admitting unrelated work', () => {
  const store = createStore([
    {
      id: 'root',
      kind: 'implementation',
      title: 'Root source',
      dependencies: [],
      writePaths: ['src'],
      acceptanceCriteria: ['Root source change is verified'],
    },
    {
      id: 'nested',
      kind: 'implementation',
      title: 'Nested source',
      dependencies: [],
      writePaths: ['src\\feature'],
      acceptanceCriteria: ['Nested source change is verified'],
    },
    {
      id: 'docs',
      kind: 'implementation',
      title: 'Docs',
      dependencies: [],
      writePaths: ['docs/'],
      acceptanceCriteria: ['Documentation change is verified'],
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
