#!/usr/bin/env node
/**
 * verify scope must include structured verification tools so verify-profile
 * sub-agents can close the loop without only using raw exec.
 */
import assert from 'node:assert/strict';
import {
  resolveSpawnToolSet,
  createSpawnProfileRegistryFromDefaults,
} from '../dist/core/subagent/spawn-profile.js';

const registry = createSpawnProfileRegistryFromDefaults();
const verify = resolveSpawnToolSet('verify', registry);
assert.ok(verify, 'verify scope returns a set');
for (const name of ['run_tests', 'verify_fix', 'code_diagnostics', 'exec', 'todo_write']) {
  assert.ok(verify.has(name), `verify scope includes ${name}`);
}
// Must not silently include write tools (verify is not full)
assert.equal(verify.has('write_file'), false, 'verify is not full write scope');
assert.equal(verify.has('edit_file'), false, 'verify is not full edit scope');

const explore = resolveSpawnToolSet('explore', registry);
assert.ok(explore);
assert.equal(explore.has('run_tests'), false, 'explore stays read-only for tests');
assert.ok(explore.has('load_skill'), 'explore can load skill bodies after discovery');
assert.ok(explore.has('skillhub_search'), 'explore can search skill marketplace');

console.log('[PASS] spawn-verify-scope');
