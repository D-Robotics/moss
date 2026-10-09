#!/usr/bin/env node
/**
 * Live rdk-docs-mcp check. CI does not set RDK_DOCS_LIVE, so this skips.
 * A skip is not a failure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpClient } from '../dist/core/mcp/client.js';
import { builtinRdkDocsServerConfig } from '../dist/core/mcp/rdk-docs.js';

test('list_manuals includes rdk-x and rdk-s', async () => {
  if (process.env.RDK_DOCS_LIVE !== '1') {
    console.log('[mcp-rdk-docs-live] not run: set RDK_DOCS_LIVE=1 to call rdk-docs-mcp');
    return;
  }
  const client = new McpClient(builtinRdkDocsServerConfig());
  try {
    await client.connect();
    const result = await client.callTool('list_manuals', {});
    const text = JSON.stringify(result);
    assert.match(text, /rdk-x/);
    assert.match(text, /rdk-s/);
  } finally {
    await client.close();
  }
});
