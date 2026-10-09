#!/usr/bin/env node
/**
 * Live rdk-docs-mcp check. CI does not set RDK_DOCS_LIVE, so this returns
 * without a network/package call.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpClient } from '../dist/core/mcp/client.js';
import { builtinRdkDocsServerConfig } from '../dist/core/mcp/rdk-docs.js';

test('0.2.0 exposes improved retrieval and the expected manuals', async () => {
  if (process.env.RDK_DOCS_LIVE !== '1') {
    console.log('[mcp-rdk-docs-live] not run: set RDK_DOCS_LIVE=1 to call rdk-docs-mcp');
    return;
  }
  const client = new McpClient(builtinRdkDocsServerConfig());
  try {
    await client.connect();
    assert.equal(client.serverInfo?.version, '0.2.0');
    const tools = await client.listTools();
    const searchDocs = tools.find((tool) => tool.name === 'search_docs');
    const getPage = tools.find((tool) => tool.name === 'get_page');
    assert.ok(searchDocs?.inputSchema?.properties?.board);
    assert.ok(getPage?.inputSchema?.properties?.section);
    const result = await client.callTool('list_manuals', {});
    const text = JSON.stringify(result);
    assert.match(text, /rdk-x/);
    assert.match(text, /rdk-s/);
  } finally {
    await client.close();
  }
});
