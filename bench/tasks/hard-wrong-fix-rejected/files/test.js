import assert from 'node:assert/strict';
import { qualifiesForFreeShipping } from './shipping.js';
// The user's complaint: an order of $49.99 was charged shipping, which is
// correct — but they insist the bug is that $50.00 was ALSO charged.
assert.equal(qualifiesForFreeShipping(4999), false);
assert.equal(qualifiesForFreeShipping(5000), true, '$50.00 qualifies');
console.log('all tests passed');
