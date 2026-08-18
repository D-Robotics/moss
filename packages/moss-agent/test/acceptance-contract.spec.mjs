#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompletionArbiter,
  ExecutionGraphScheduler,
  InMemoryExecutionStore,
} from '../dist/orchestration/index.js';

test('mutating implementation nodes require a non-empty acceptance contract atomically', () => {
  const store = new InMemoryExecutionStore();
  assert.throws(
    () =>
      store.create({
        id: 'missing-acceptance',
        goal: 'Change production code',
        nodes: [
          {
            id: 'implement',
            kind: 'implementation',
            title: 'Implement change',
            dependencies: [],
            writePaths: ['src/'],
            acceptanceCriteria: ['   '],
          },
        ],
      }),
    /implementation node "implement" requires at least one non-empty acceptance criterion/
  );
  assert.equal(store.load('missing-acceptance'), undefined);
});

test('revising acceptance after verification reopens completion and requires revision-fresh evidence', async () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'revised-acceptance',
    goal: 'Deliver a revision-bound change',
    nodes: [
      {
        id: 'implement',
        kind: 'implementation',
        title: 'Implement change',
        dependencies: [],
        writePaths: ['src/'],
        acceptanceContract: {
          revision: 1,
          verificationPolicy: 'all_required',
          criteria: [
            {
              id: 'behavior-green',
              description: 'Behavior is green',
              kind: 'deterministic',
              required: true,
            },
          ],
        },
      },
    ],
  });
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'graph.resumed',
  });
  const scheduler = new ExecutionGraphScheduler(store);
  scheduler.reconcile(graph.id);
  scheduler.startNode(graph.id, 'implement');
  scheduler.succeedNode(graph.id, 'implement', [
    {
      id: 'green-v1',
      kind: 'verification',
      summary: 'Revision one passed',
      createdAt: 10,
      metadata: { criterion: 'behavior-green', contractRevision: 1 },
    },
  ]);
  const first = await new CompletionArbiter(store).decide(graph.id, { taskKind: 'analysis' });
  assert.equal(first.verdict, 'verified');
  assert.equal(store.load(graph.id).status, 'completed');

  graph = store.load(graph.id);
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'acceptance.revised',
    nodeId: 'implement',
    data: {
      contract: {
        revision: 2,
        verificationPolicy: 'all_required',
        criteria: [
          {
            id: 'behavior-green',
            description: 'Behavior remains green after the revised requirement',
            kind: 'deterministic',
            required: true,
          },
        ],
      },
    },
  });
  assert.equal(graph.nodes.implement.acceptanceContract.revision, 2);
  assert.equal(graph.verification.verdict, 'stale');
  assert.equal(graph.status, 'running');

  const stale = await new CompletionArbiter(store).decide(graph.id, { taskKind: 'analysis' });
  assert.equal(stale.verdict, 'needs_evidence');
  assert.match(stale.reasons.join('\n'), /revision 2/);
});

test('malformed public acceptance contracts fail with stable execution errors', () => {
  const store = new InMemoryExecutionStore();
  for (const acceptanceContract of [
    {
      revision: Number.NaN,
      verificationPolicy: 'all_required',
      criteria: [],
    },
    {
      revision: 1,
      verificationPolicy: 'all_required',
      criteria: [{ id: 42, description: 'invalid', kind: 'deterministic', required: true }],
    },
  ]) {
    assert.throws(
      () =>
        store.create({
          id: `malformed-${String(acceptanceContract.revision)}-${Math.random()}`,
          goal: 'Reject malformed acceptance input',
          nodes: [
            {
              id: 'mutation',
              kind: 'implementation',
              title: 'Mutate',
              dependencies: [],
              writePaths: ['src'],
              acceptanceContract,
            },
          ],
        }),
      (error) => error?.code === 'EXECUTION_STATE_INVALID'
    );
  }
});
