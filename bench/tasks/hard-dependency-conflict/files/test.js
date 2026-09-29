import assert from 'node:assert/strict';
import { legacyGreeting } from './legacy-app.js';
import { modernGreeting } from './modern-app.js';

assert.equal(legacyGreeting({ name: 'ada' }), 'a user record: ada');
assert.equal(modernGreeting({ name: 'ada' }), 'kind=user: ada');
console.log('all tests passed');
