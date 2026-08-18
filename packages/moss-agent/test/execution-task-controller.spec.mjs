#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionTaskController, InMemoryExecutionStore } from '../dist/orchestration/index.js';

test('task controller exposes consistent list, inspect, resume, retry, and stop actions', () => {
  const store = new InMemoryExecutionStore();
  store.create({
    id: 'task-1',
    goal: 'recover me',
    nodes: [{ id: 'analysis', kind: 'analysis', title: 'analyse', dependencies: [] }],
  });
  const tasks = new ExecutionTaskController(store);
  assert.deepEqual(
    tasks.list().map((task) => task.id),
    ['task-1']
  );
  assert.equal(tasks.inspect('task-1').revision, 1);
  assert.equal(tasks.resume('task-1').status, 'running');

  let graph = store.load('task-1');
  for (const type of ['node.ready', 'node.started', 'node.failed']) {
    graph = store.append('task-1', {
      expectedRevision: graph.revision,
      type,
      nodeId: 'analysis',
      ...(type === 'node.failed' ? { data: { error: 'transient' } } : {}),
    });
  }
  assert.equal(tasks.retry('task-1', 'analysis').nodes.analysis.status, 'ready');
  assert.equal(tasks.stop('task-1').status, 'cancelled');
  assert.equal(tasks.stop('task-1').revision, tasks.inspect('task-1').revision);
  assert.throws(() => tasks.resume('task-1'), /is cancelled/);
});
