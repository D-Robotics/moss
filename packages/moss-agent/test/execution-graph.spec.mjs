#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  InMemoryExecutionStore,
  JsonlExecutionStore,
  recoverExecutionGraph,
} from '../dist/orchestration/index.js';

function graphInput(id = 'graph-1') {
  return {
    id,
    goal: 'Implement and verify a durable task',
    sessionId: 'session-1',
    nodes: [
      {
        id: 'analyse',
        kind: 'analysis',
        title: 'Analyse requirements',
        dependencies: [],
        requiredCapabilities: ['architecture'],
        acceptanceCriteria: ['claims cite evidence'],
      },
      {
        id: 'implement',
        kind: 'implementation',
        title: 'Implement change',
        dependencies: ['analyse'],
        requiredCapabilities: ['code'],
        writePaths: ['src/'],
        acceptanceCriteria: ['patch produced'],
      },
    ],
    policy: { maxConcurrency: 4, maxAttemptsPerNode: 3, strictCompletion: true },
    budget: { maxTokens: 20_000, maxCostUsd: 5, maxWallTimeMs: 3_600_000 },
    now: 10,
  };
}

test('in-memory execution graph enforces revision CAS and legal node transitions', () => {
  const store = new InMemoryExecutionStore();
  const created = store.create(graphInput());
  assert.equal(created.revision, 1);
  assert.equal(created.status, 'paused');
  assert.equal(created.nodes.analyse.status, 'pending');

  const ready = store.append('graph-1', {
    id: 'event-ready',
    expectedRevision: 1,
    type: 'node.ready',
    nodeId: 'analyse',
    time: 20,
  });
  assert.equal(ready.revision, 2);
  assert.equal(ready.nodes.analyse.status, 'ready');

  assert.throws(
    () =>
      store.append('graph-1', {
        expectedRevision: 1,
        type: 'node.started',
        nodeId: 'analyse',
      }),
    (error) => error?.code === 'EXECUTION_REVISION_CONFLICT'
  );
  assert.throws(
    () =>
      store.append('graph-1', {
        expectedRevision: 2,
        type: 'node.succeeded',
        nodeId: 'implement',
      }),
    /cannot transition from pending to succeeded/
  );

  const duplicate = store.append('graph-1', {
    id: 'event-ready',
    expectedRevision: 1,
    type: 'node.ready',
    nodeId: 'analyse',
  });
  assert.equal(duplicate.revision, 2);
});

test('owner lease excludes a second local runtime and expires deterministically', () => {
  let now = 100;
  const store = new InMemoryExecutionStore({ now: () => now });
  store.create(graphInput());
  const first = store.acquireLease('graph-1', { ownerId: 'cli', ttlMs: 30 });
  assert.equal(first.ownerId, 'cli');
  assert.throws(
    () => store.acquireLease('graph-1', { ownerId: 'web', ttlMs: 30 }),
    (error) => error?.code === 'EXECUTION_LEASE_HELD'
  );
  now = 131;
  const second = store.acquireLease('graph-1', { ownerId: 'web', ttlMs: 30 });
  assert.equal(second.ownerId, 'web');
  assert.throws(() => store.releaseLease('graph-1', first), /lease token/);
  store.releaseLease('graph-1', second);
});

test('JSONL store persists CAS across instances, snapshots, and repairs only a corrupt tail', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-execution-graph-'));
  try {
    const first = new JsonlExecutionStore({ rootDir, snapshotEvery: 2 });
    first.create(graphInput());
    first.append('graph-1', {
      expectedRevision: 1,
      type: 'node.ready',
      nodeId: 'analyse',
      time: 20,
    });

    const second = new JsonlExecutionStore({ rootDir, snapshotEvery: 2 });
    assert.equal(second.load('graph-1')?.revision, 2);
    assert.throws(
      () =>
        second.append('graph-1', {
          expectedRevision: 1,
          type: 'node.started',
          nodeId: 'analyse',
        }),
      (error) => error?.code === 'EXECUTION_REVISION_CONFLICT'
    );
    second.append('graph-1', {
      expectedRevision: 2,
      type: 'node.started',
      nodeId: 'analyse',
      time: 30,
    });

    const graphDir = path.join(rootDir, 'graph-1');
    assert.ok(fs.existsSync(path.join(graphDir, 'snapshot.json')));
    fs.appendFileSync(path.join(graphDir, 'events.jsonl'), '{truncated');

    const recovered = new JsonlExecutionStore({ rootDir, snapshotEvery: 2 });
    assert.equal(recovered.load('graph-1')?.revision, 3);
    assert.equal(recovered.load('graph-1')?.nodes.analyse.status, 'running');
    assert.ok(
      fs.readdirSync(graphDir).some((name) => name.startsWith('events.corrupt.')),
      'invalid tail should be quarantined for inspection'
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('restart recovery is fail-closed for active work', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create(graphInput());
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'graph.resumed',
    time: 20,
  });
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'node.ready',
    nodeId: 'analyse',
    time: 30,
  });
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'node.started',
    nodeId: 'analyse',
    time: 40,
  });

  const recovered = recoverExecutionGraph(store, graph.id, { now: 50 });
  assert.equal(recovered.status, 'paused_recovered');
  assert.equal(recovered.nodes.analyse.status, 'interrupted');
  assert.equal(recovered.recovery?.requiresUserResume, true);
  assert.equal(recovered.recovery?.interruptedNodeIds[0], 'analyse');
});
