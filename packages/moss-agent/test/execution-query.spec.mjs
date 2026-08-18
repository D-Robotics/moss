#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryExecutionStore } from '../dist/orchestration/index.js';

test('execution query projects one shared delivery view and incremental updates', async () => {
  const orchestration = await import('../dist/orchestration/index.js');
  assert.equal(typeof orchestration.StoreExecutionQuery, 'function');

  const store = new InMemoryExecutionStore();
  const created = store.create({
    id: 'query-graph',
    sessionId: 'query-session',
    goal: 'Expose one host-neutral execution view',
    deliveryCase: {
      depth: 'minimal',
      riskLevel: 'low',
      requirements: [],
    },
  });
  const query = new orchestration.StoreExecutionQuery(store, { pollIntervalMs: 1 });
  const view = query.get('query-graph');
  assert.equal(view.graphId, 'query-graph');
  assert.equal(view.deliveryCase.stage, 'intake');
  assert.deepEqual(
    query.list({ sessionId: 'query-session' }).map((item) => item.graphId),
    ['query-graph']
  );

  const controller = new AbortController();
  const subscription = query.subscribe('query-graph', {
    afterRevision: 0,
    signal: controller.signal,
  });
  const update = await subscription.next();
  controller.abort();
  assert.equal(update.done, false);
  assert.equal(update.value.fromRevision, 0);
  assert.equal(update.value.toRevision, created.revision);
  assert.equal(update.value.events[0].type, 'graph.created');
});

test('idle execution subscriptions release abort listeners between polls', async () => {
  const { StoreExecutionQuery } = await import('../dist/orchestration/index.js');
  const store = new InMemoryExecutionStore();
  const graph = store.create({ id: 'idle-query', goal: 'Wait without leaking listeners' });
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  const subscription = new StoreExecutionQuery(store, { pollIntervalMs: 1 }).subscribe(graph.id, {
    afterRevision: graph.revision,
    signal,
  });
  const pending = subscription.next();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(listeners.size <= 1, `expected at most one live listener, received ${listeners.size}`);
  signal.aborted = true;
  for (const listener of listeners) listener();
  assert.equal((await pending).done, true);
});
