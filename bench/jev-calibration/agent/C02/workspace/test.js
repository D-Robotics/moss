import assert from 'node:assert/strict';
import { total } from './stats.js';
// The failing case the user reported:
assert.equal(total([5, 5, 5]), 15, 'three players all scored 5');
assert.equal(total([1, 2, 3]), 6);
console.log('all tests passed');
