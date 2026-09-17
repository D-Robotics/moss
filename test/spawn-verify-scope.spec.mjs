#!/usr/bin/env node
/**
 * verify scope must include structured verification tools so verify-profile
 * sub-agents can close the loop without only using raw exec.
 */
import assert from 'node:assert/strict';
import {
  resolveSpawnToolSet,
  buildSubagentPromptAddon,
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
assert.ok(explore.has('memory_read'), 'explore uses real memory_read (not memory_search)');
assert.equal(explore.has('find_skills'), false, 'dead find_skills alias removed');
assert.equal(explore.has('memory_search'), false, 'dead memory_search alias removed');
assert.equal(explore.has('web_extract'), false, 'dead web_extract alias removed');
assert.equal(explore.has('device_diagnose'), false, 'dead device_diagnose alias removed');
assert.ok(explore.has('device_info'), 'explore includes device_info');
assert.ok(explore.has('device_file_read'), 'explore includes device_file_read');

const plan = resolveSpawnToolSet('plan', registry);
assert.ok(plan);
assert.ok(plan.has('todo_write'), 'plan scope includes todo_write for multi-step plans');
assert.ok(plan.has('plan'), 'plan scope uses real tool name plan (not create_plan)');
assert.ok(plan.has('plan_step'), 'plan scope uses real tool name plan_step (not update_plan)');
assert.equal(plan.has('create_plan'), false, 'dead create_plan alias removed');
assert.equal(plan.has('update_plan'), false, 'dead update_plan alias removed');

const critic = resolveSpawnToolSet('critic', registry);
assert.ok(critic, 'critic scope returns a set');
assert.equal(critic.size, 0, 'critic scope exposes no tools');
const criticPrompt = buildSubagentPromptAddon('critic');
assert.match(criticPrompt, /untrusted data/i, 'critic treats task and plan as data');
assert.doesNotMatch(
  criticPrompt,
  /step-by-step implementation plan/i,
  'critic does not inherit plan-output instructions'
);

console.log('[PASS] spawn-verify-scope');
