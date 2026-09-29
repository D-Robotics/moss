import assert from 'node:assert/strict';
import { renderReport } from './report.js';
assert.equal(renderReport({ revenue: 12345, cost: 6789, growth: 1.073 }),
  'revenue: 12345.00\ncost: 6789.00\ngrowth: 1.073');
console.log('all tests passed');
