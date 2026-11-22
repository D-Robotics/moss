import assert from 'node:assert/strict';
import { clamp } from './math.js';

assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-3, 0, 10), 0);
assert.equal(clamp(13, 0, 10), 10);
assert.equal(clamp(2, 2, 8), 2);
assert.equal(clamp(8, 2, 8), 8);
console.log('all tests passed');
