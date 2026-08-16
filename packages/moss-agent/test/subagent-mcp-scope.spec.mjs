import assert from 'node:assert/strict';

import { selectSubagentTools } from '../dist/core/subagent/subagent-runner.js';
import { createSpawnProfileRegistryFromDefaults } from '../dist/core/subagent/spawn-profile.js';

const registry = createSpawnProfileRegistryFromDefaults();
registry.registerSpawnToolExtensions({
  'read-only': ['read_file', 'mcp__docs__search'],
});
const parentTools = [
  { name: 'read_file', metadata: { sideEffectClass: 'readonly' } },
  { name: 'mcp__docs__search', metadata: { sideEffectClass: 'readonly' } },
  { name: 'mcp__other__unsafe', metadata: { sideEffectClass: 'external_message' } },
  { name: 'exec', metadata: { sideEffectClass: 'local_write' } },
];

assert.deepEqual(
  selectSubagentTools(
    parentTools,
    {
      runId: 'child-a',
      parentRunId: 'parent-a',
      scope: 'read-only',
      task: 'Research',
      allowedTools: ['read_file', 'mcp__docs__search', 'mcp__other__unsafe'],
    },
    registry
  ).map((tool) => tool.name),
  ['read_file', 'mcp__docs__search']
);

console.log('[PASS] approved MCP tools survive actual subagent scope and exact-name filtering');
