#!/usr/bin/env node
import assert from 'node:assert/strict';

import { CordisEffectScope } from '../dist/vendor/cordis/effect-scope.js';

const events = [];
const scope = new CordisEffectScope();
scope.add(() => events.push('first'), 'first');
scope.add(async () => events.push('second'), 'second');
scope.add(() => {
  events.push('failing');
  throw new Error('cleanup failed');
}, 'failing');

const firstDispose = scope.dispose();
assert.equal(scope.state, 'disposing');
await assert.rejects(firstDispose, AggregateError);
await assert.rejects(scope.dispose(), AggregateError, 'repeat dispose joins the same result');
assert.equal(scope.state, 'disposed');
assert.deepEqual(events, ['failing', 'second', 'first']);
assert.throws(() => scope.add(() => {}, 'late'), /disposed effect scope/);

const single = new CordisEffectScope();
let calls = 0;
const disposeOne = single.add(() => calls++, 'single');
await disposeOne();
await disposeOne();
await single.dispose();
assert.equal(calls, 1, 'public effect disposal is single-shot');

console.log(
  '[PASS] vendored Cordis effect scope is awaited, LIFO, failure-tolerant, and idempotent'
);
