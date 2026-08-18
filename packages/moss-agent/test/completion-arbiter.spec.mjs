#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompletionArbiter,
  ExecutionGraphScheduler,
  InMemoryExecutionStore,
} from '../dist/orchestration/index.js';

function createCodingGraph() {
  const store = new InMemoryExecutionStore();
  store.create({
    id: 'coding',
    goal: 'Change code safely',
    nodes: [
      {
        id: 'implement',
        kind: 'implementation',
        title: 'Implement',
        dependencies: [],
        writePaths: ['src'],
        acceptanceCriteria: ['patch-merged'],
      },
      {
        id: 'verify',
        kind: 'verification',
        title: 'Verify',
        dependencies: ['implement'],
        acceptanceCriteria: ['tests-green'],
      },
    ],
    policy: { strictCompletion: true },
    now: 1,
  });
  return store;
}

function append(store, graphId, input) {
  const graph = store.load(graphId);
  return store.append(graphId, { expectedRevision: graph.revision, ...input });
}

test('model success text cannot override missing deterministic coding evidence', async () => {
  const store = createCodingGraph();
  const scheduler = new ExecutionGraphScheduler(store);
  scheduler.reconcile('coding');
  scheduler.startNode('coding', 'implement');
  scheduler.succeedNode('coding', 'implement');
  scheduler.reconcile('coding');
  scheduler.startNode('coding', 'verify');
  scheduler.succeedNode('coding', 'verify');
  let semanticCalls = 0;

  const decision = await new CompletionArbiter(store).decide('coding', {
    taskKind: 'coding',
    semanticJudge: async () => {
      semanticCalls += 1;
      return { covered: true, reasons: [] };
    },
  });

  assert.equal(decision.verdict, 'needs_evidence');
  assert.equal(decision.status, 'blocked');
  assert.equal(semanticCalls, 0);
  assert.match(decision.reasons.join('\n'), /merged patch evidence/);
  assert.equal(store.load('coding').status, 'blocked');
});

test('coding completion requires merged patch followed by fresh green verification', async () => {
  const store = createCodingGraph();
  const scheduler = new ExecutionGraphScheduler(store);
  scheduler.reconcile('coding');
  scheduler.startNode('coding', 'implement');
  scheduler.succeedNode('coding', 'implement', [
    {
      id: 'patch',
      kind: 'patch',
      summary: 'Patch merged',
      createdAt: 10,
      metadata: { merged: true, criterion: 'patch-merged' },
    },
  ]);
  scheduler.reconcile('coding');
  scheduler.startNode('coding', 'verify');
  scheduler.succeedNode('coding', 'verify', [
    {
      id: 'verify-green',
      kind: 'verification',
      summary: 'Tests passed after merge',
      createdAt: 20,
      metadata: { fresh: true, exitCode: 0, criterion: 'tests-green' },
    },
  ]);

  const decision = await new CompletionArbiter(store).decide('coding', {
    taskKind: 'coding',
    semanticJudge: async () => ({ covered: true, reasons: [] }),
  });
  assert.equal(decision.verdict, 'verified');
  assert.equal(decision.status, 'completed');
  assert.deepEqual(decision.evidenceIds.sort(), ['patch', 'verify-green']);
  assert.equal(store.load('coding').verification.verdict, 'verified');
  assert.equal(store.load('coding').status, 'completed');
});

test('verification older than the merged patch is not fresh evidence', async () => {
  const store = createCodingGraph();
  for (const [nodeId, evidence] of [
    [
      'implement',
      {
        id: 'patch-newer',
        kind: 'patch',
        summary: 'Patch merged later',
        createdAt: 30,
        metadata: { merged: true, criterion: 'patch-merged' },
      },
    ],
    [
      'verify',
      {
        id: 'verify-old',
        kind: 'verification',
        summary: 'Old green run',
        createdAt: 20,
        metadata: { fresh: true, exitCode: 0, criterion: 'tests-green' },
      },
    ],
  ]) {
    append(store, 'coding', { type: 'node.ready', nodeId });
    append(store, 'coding', { type: 'node.started', nodeId });
    append(store, 'coding', {
      type: 'evidence.recorded',
      nodeId,
      data: { evidence: { ...evidence, nodeId } },
    });
    append(store, 'coding', { type: 'node.succeeded', nodeId });
  }
  const decision = await new CompletionArbiter(store).decide('coding', { taskKind: 'coding' });
  assert.equal(decision.verdict, 'needs_evidence');
  assert.match(decision.reasons.join('\n'), /fresh verification after the latest patch/);
});

test('active background work and workspace leases keep a graph in progress', async () => {
  const store = createCodingGraph();
  const decision = await new CompletionArbiter(store).decide('coding', {
    taskKind: 'coding',
    activeBackgroundTaskIds: ['background-1'],
    activeWorkspaceLeaseIds: ['lease-1'],
  });
  assert.equal(decision.status, 'in_progress');
  assert.equal(store.load('coding').status, 'paused');
  assert.match(decision.reasons.join('\n'), /background-1/);
  assert.match(decision.reasons.join('\n'), /lease-1/);
});

test('research and device tasks require citations and real probe receipts', async () => {
  for (const [graphId, taskKind, evidenceKind] of [
    ['research', 'research', 'citation'],
    ['device', 'device', 'probe_receipt'],
  ]) {
    const store = new InMemoryExecutionStore();
    store.create({
      id: graphId,
      goal: `Complete ${taskKind}`,
      nodes: [{ id: 'work', kind: 'analysis', title: 'Work', dependencies: [] }],
    });
    const scheduler = new ExecutionGraphScheduler(store);
    scheduler.reconcile(graphId);
    scheduler.startNode(graphId, 'work');
    scheduler.succeedNode(graphId, 'work', [
      {
        id: `${graphId}-evidence`,
        kind: evidenceKind,
        summary: `${taskKind} evidence`,
        createdAt: 10,
        metadata: taskKind === 'device' ? { real: true } : {},
      },
    ]);
    const decision = await new CompletionArbiter(store).decide(graphId, { taskKind });
    assert.equal(decision.verdict, 'verified');
  }
});
