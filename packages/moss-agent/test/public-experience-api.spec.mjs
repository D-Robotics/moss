import assert from 'node:assert/strict';
import { createObjectiveVerifierHook } from '../dist/core/index.js';
import { ExperienceLog } from '../dist/memory/index.js';

assert.equal(typeof ExperienceLog, 'function');
assert.equal(typeof createObjectiveVerifierHook, 'function');

console.log('[PASS] public experience collection APIs are exported from package subpaths');
