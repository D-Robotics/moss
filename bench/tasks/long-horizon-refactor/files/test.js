import assert from 'node:assert/strict';
import { renderRow } from './src/app/table.js';
import { renderBanner } from './src/app/banner.js';

assert.equal(renderRow(['a', 'b'], [5, 5]), '  a   |   b  ');
assert.equal(renderBanner('title', 11), '   title   ');
const long = 'x'.repeat(30);
assert.ok(renderBanner(long, 10).length <= 10);
console.log('all tests passed');
