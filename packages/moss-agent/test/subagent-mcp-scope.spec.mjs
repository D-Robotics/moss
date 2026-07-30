import assert from 'node:assert/strict';

import { selectSubagentTools } from '../src/core/subagent/subagent-runner.ts';
import { createSpawnProfileRegistryFromDefaults } from '../src/core/subagent/spawn-profile.ts';

const registry = createSpawnProfileRegistryFromDefaults();
registry.registerSpawnToolExtensions({
  'read-only': ['read_file', 'mcp__docs__search'],
});
const parentTools = [
  { name: 'read_file' },
  { name: 'mcp__docs__search' },
  { name: 'mcp__other__unsafe' },
  { name: 'exec' },
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
