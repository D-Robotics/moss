import assert from 'node:assert/strict';
import { push, size } from './queue.js';

const results = [];
const mk = (id) => () =>
  new Promise((resolve) => {
    setTimeout(() => {
      results.push(id);
      resolve();
    }, 1 + (id % 3));
  });

// Ten jobs pushed synchronously. size() right after must count every one.
for (let i = 0; i < 10; i++) push(mk(i));
assert.equal(size(), 10, `all 10 jobs queued immediately (got ${size()})`);
await new Promise((r) => setTimeout(r, 120));
assert.equal(results.length, 10, `all 10 jobs ran (got ${results.length})`);
console.log('all tests passed');
