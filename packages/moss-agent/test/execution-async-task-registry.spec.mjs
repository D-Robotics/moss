#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryMossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';
import { ExecutionBackedAsyncTaskRegistry } from '../dist/orchestration/execution-async-task-registry.js';
import { InMemoryExecutionStore } from '../dist/orchestration/index.js';

test('background task lifecycle is retained as structured execution evidence', async () => {
  const store = new InMemoryExecutionStore();
  const registry = new ExecutionBackedAsyncTaskRegistry(
    createInMemoryMossAsyncTaskRegistry(),
    store
  );
  registry.start(
    { taskId: 'parent/sub-1', kind: 'subagent', label: 'analyse', payload: {} },
    async () => ({ success: true, summary: 'model prose is not copied' })
  );
  const completion = await registry.wait('parent/sub-1');
  assert.equal(completion.success, true);
  const graph = store.list()[0];
  assert.equal(graph.status, 'completed');
  assert.equal(graph.nodes['background-task'].status, 'succeeded');
  assert.equal(graph.evidence[0].summary, 'background task succeeded');
  assert.equal(JSON.stringify(graph).includes('model prose is not copied'), false);
});

test('stopping background work cancels its graph instead of losing it', async () => {
  const store = new InMemoryExecutionStore();
  const registry = new ExecutionBackedAsyncTaskRegistry(
    createInMemoryMossAsyncTaskRegistry(),
    store
  );
  registry.start(
    { taskId: 'stop-me', kind: 'host_task', payload: {} },
    (_request, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
  );
  assert.equal(registry.stop('stop-me'), true);
  assert.equal(store.list()[0].status, 'cancelled');
  await registry.wait('stop-me');
});
