#!/usr/bin/env node
/**
 * Closing a server that is still starting is not "rdk-docs unreachable".
 * A real connect failure stays failed.
 */
import assert from 'node:assert/strict';

import { McpToolRegistry } from '../dist/core/mcp/registry.js';

const slow = {
  name: 'rdk-docs',
  transport: 'stdio',
  command: process.execPath,
  args: ['-e', 'setTimeout(() => {}, 30000)'],
};

{
  const registry = McpToolRegistry.connectInBackground([slow]);
  await registry.closeAll();
  const status = registry.getStatuses().find((row) => row.name === 'rdk-docs');
  assert.ok(status);
  assert.notEqual(status.state, 'failed');
  assert.equal(status.error, undefined);
}

{
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'rdk-docs',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    },
  ]);
  await registry.waitForConnections();
  const status = registry.getStatuses().find((row) => row.name === 'rdk-docs');
  assert.equal(status?.state, 'failed');
  await registry.closeAll();
}

console.log('[PASS] mcp shutdown notice');
