#!/usr/bin/env node
import assert from 'node:assert/strict';

import { ToolRegistry } from '../dist/core/tools/tool-registry.js';

function tool(name, marker) {
  return {
    name,
    description: marker,
    inputSchema: { type: 'object', properties: {} },
    sideEffects: { kind: 'readonly' },
    async execute() {
      return marker;
    },
  };
}

const registry = new ToolRegistry();
const pluginTool = tool('shared_name', 'plugin');
registry.registerScoped(pluginTool, 'plugin:sample');

assert.throws(
  () => registry.register(tool('shared_name', 'late builtin')),
  /tool already registered: shared_name/
);
assert.equal(registry.get('shared_name'), pluginTool);
assert.equal(registry.getGroupForTool('shared_name'), 'plugin:sample');

const replacement = tool('shared_name', 'explicit replacement');
registry.replace(replacement, 'host:configured');
assert.equal(registry.get('shared_name'), replacement);
assert.equal(registry.getGroupForTool('shared_name'), 'host:configured');

console.log('  [PASS] tool registry preserves lifecycle ownership unless replacement is explicit');
