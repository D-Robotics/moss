import assert from 'node:assert/strict';
import { BoundedQueue } from './queue.js';

const q = new BoundedQueue(3);
assert.equal(q.size(), 0, 'empty queue size');
assert.equal(q.dequeue(), null, 'dequeue on empty returns null');
assert.equal(q.enqueue('a'), true);
assert.equal(q.enqueue('b'), true);
assert.equal(q.enqueue('c'), true);
assert.equal(q.enqueue('d'), false, 'enqueue beyond capacity returns false');
assert.equal(q.size(), 3, 'size after three enqueues');
assert.equal(q.peek(), 'a');
assert.equal(q.dequeue(), 'a');
assert.equal(q.size(), 2, 'size after one dequeue');
console.log('all tests passed');
