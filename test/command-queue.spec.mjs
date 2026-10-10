import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandQueueRegistry } from '../dist/index.js';

async function runBatch(registry, lane, expectedConcurrency) {
  const releases = [];
  const gates = Array.from({ length: 3 }, () => new Promise((resolve) => releases.push(resolve)));
  let active = 0;
  let maximum = 0;
  let entered = 0;
  const runs = gates.map((gate, index) =>
    registry.enqueue(lane, async () => {
      entered++;
      maximum = Math.max(maximum, ++active);
      await gate;
      active--;
      return index;
    })
  );
  try {
    assert.equal(entered, expectedConcurrency, 'idle configuration controls real task entry');
    assert.equal(registry.delete(lane), false, 'an active queue cannot be cleared');
  } finally {
    releases.forEach((release) => release());
    assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  }
  assert.equal(maximum, expectedConcurrency);
}

test('configured concurrency survives idle setup, drain, and clearing runtime state', async () => {
  const registry = new CommandQueueRegistry();
  registry.setConcurrency('parallel', 3);
  await runBatch(registry, 'parallel', 3);
  await runBatch(registry, 'parallel', 3);
  registry.delete('parallel');
  await runBatch(registry, 'parallel', 3);
});

test('limit one and unconfigured lanes stay serial after draining', async () => {
  const registry = new CommandQueueRegistry();
  registry.setConcurrency('serial', 1);
  await runBatch(registry, 'serial', 1);
  await runBatch(registry, 'serial', 1);
  await runBatch(registry, 'default', 1);
  assert.equal(registry.delete('default'), false, 'unconfigured idle lanes are cleaned up');
});
