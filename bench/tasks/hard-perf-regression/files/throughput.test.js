import assert from 'node:assert/strict';
import { flatten, summary } from './catalog.js';
// Performance lock: flatten must be effectively linear. This wall-clock
// bound fails on quadratic implementations (array copying in a loop).
function build(n, depth) {
  const tree = [];
  for (let i = 0; i < n; i++) {
    let node = { name: `n${i}` };
    for (let d = 0; d < depth; d++) node = { name: `d${d}-${i}`, children: [node] };
    tree.push(node);
  }
  return tree;
}
const big = build(5000, 9); // 50000 nodes
const start = process.hrtime.bigint();
const out = flatten(big);
const ms = Number(process.hrtime.bigint() - start) / 1e6;
assert.equal(out.length, 50000, 'all nodes listed');
assert.ok(
  ms < 150,
  `flatten took ${ms.toFixed(1)}ms for 50000 nodes — expected effectively linear (quadratic concat blows past this)`
);
console.log(`throughput ok (${ms.toFixed(2)}ms)`);
