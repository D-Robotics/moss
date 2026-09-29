import assert from 'node:assert/strict';
import { totalCents } from './cart.js';
assert.equal(totalCents([{ priceCents: 10.5, qty: 1 }]), 11, 'half-up per line');
assert.equal(totalCents([{ priceCents: 10.4, qty: 3 }]), 31, '3 x 10.4 = 31.2 -> 31');
assert.equal(totalCents([]), 0);
console.log('all tests passed');
