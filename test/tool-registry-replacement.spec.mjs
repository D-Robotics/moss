#!/usr/bin/env node
import assert from 'node:assert/strict';

import { ToolRegistry } from '../dist/core/tools/tool-registry.js';

function tool(name, marker) {
  return {
    name,
    description: marker,
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    async execute() {
      return marker;
    },
  };
}

const registry = new ToolRegistry();
const first = tool('shared_name', 'first');
registry.register(first);
const second = tool('shared_name', 'second');
registry.register(second);
assert.equal(registry.get('shared_name'), second);
assert.deepEqual(registry.getNames(), ['shared_name']);

const explicit = tool('shared_name', 'explicit replacement');
registry.replace(explicit);
assert.equal(registry.get('shared_name'), explicit);
assert.equal(registry.remove('shared_name'), true);
assert.equal(registry.has('shared_name'), false);

for (const removed of [
  'registerScoped',
  'registerGroup',
  'removeGroup',
  'getGroups',
  'getGroupForTool',
]) {
  assert.equal(removed in registry, false, `${removed} belongs to the frozen plugin/group design`);
}

console.log('  [PASS] tool registry replaces tools directly and has no plugin/group lifecycle');
