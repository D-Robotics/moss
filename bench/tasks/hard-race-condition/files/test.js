import assert from 'node:assert/strict';
import { push, size, pending } from './queue.js';

const results = [];
const mk = (id) => () =>
  new Promise((resolve) => {
    setTimeout(
      () => {
        results.push(id);
        resolve();
      },
      1 + (id % 3)
    );
  });

// Ten jobs pushed synchronously. size() right after must count every one.
for (let i = 0; i < 10; i++) push(mk(i));
assert.equal(size(), 10, `all 10 jobs queued immediately (got ${size()})`);
await new Promise((r) => setTimeout(r, 120));
assert.equal(results.length, 10, `all 10 jobs ran (got ${results.length})`);

// Drain semantics: while a slow job runs, newly pushed jobs queue up and
// pending() reflects them; after the drain settles everything has run.
const ran2 = [];
const slow = () =>
  new Promise((r) =>
    setTimeout(() => {
      ran2.push('slow');
      r();
    }, 40)
  );
const quick = () =>
  new Promise((r) => {
    ran2.push('quick');
    r();
  });
push(slow);
await new Promise((r) => setTimeout(r, 5));
push(quick);
push(quick);
assert.equal(pending(), 2, `two quick jobs queued behind the slow one (got ${pending()})`);
await new Promise((r) => setTimeout(r, 120));
assert.equal(ran2.length, 3, `slow + both quick jobs ran (got ${ran2.length})`);
assert.equal(ran2[0], 'slow', 'the running job finishes before queued ones start');
console.log('all tests passed');
