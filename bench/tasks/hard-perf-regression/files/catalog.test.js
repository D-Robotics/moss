import assert from 'node:assert/strict';
import { flatten } from './catalog.js';
// Behavior lock: exact output for a known tree
const tree = [
  { name: 'a', children: [{ name: 'a1' }, { name: 'a2', children: [{ name: 'a2i' }] }] },
  { name: 'b' },
];
assert.deepEqual(flatten(tree), ['a', 'a1', 'a2', 'a2i', 'b']);
assert.deepEqual(flatten([]), []);
console.log('behavior ok');
