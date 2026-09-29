import assert from 'node:assert/strict';
import { renderReport } from './report.js';
assert.equal(
  renderReport({ revenue: 1234567, cost: 6789, growth: 1.073 }),
  'revenue: 1,234,567.00\ncost: 6,789.00\ndelta: 1,227,778.00\ngrowth: 1.073'
);
assert.equal(
  renderReport({ revenue: 500, cost: 500, growth: 0.9995 }),
  'revenue: 500.00\ncost: 500.00\ndelta: 0.00\ngrowth: 0.9995'
);
console.log('all tests passed');
