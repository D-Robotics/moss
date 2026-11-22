import assert from 'node:assert/strict';
import { total } from '../stats.js';

assert.equal(total([5, 5, 5, 5]), 20);
assert.equal(total([2, 2, 3, 3]), 10);
assert.equal(total([-3, -3, 1]), -5);
assert.equal(total([]), 0);
console.log('numeric edge cases passed');
