#!/usr/bin/env node
/**
 * Live rdk-docs-mcp check. CI does not set RDK_DOCS_LIVE, so this returns
 * without a network/package call.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpClient } from '../dist/core/mcp/client.js';
import { builtinRdkDocsServerConfig, rdkDocsPinnedNpmVersion } from '../dist/core/mcp/rdk-docs.js';

const pinnedVersion = rdkDocsPinnedNpmVersion();

test(`${pinnedVersion} lists six tools and returns compact search hits`, async () => {
  if (process.env.RDK_DOCS_LIVE !== '1') {
    console.log('[mcp-rdk-docs-live] not run: set RDK_DOCS_LIVE=1 to call rdk-docs-mcp');
    return;
  }
  const client = new McpClient(builtinRdkDocsServerConfig());
  try {
    await client.connect();
    assert.equal(client.serverInfo?.name, 'rdk-docs');
    assert.equal(client.serverInfo?.version, pinnedVersion);
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_page',
      'get_skill',
      'list_manuals',
      'list_toc',
      'search_docs',
      'search_skills',
    ]);
    const searchDocs = tools.find((tool) => tool.name === 'search_docs');
    const getPage = tools.find((tool) => tool.name === 'get_page');
    assert.ok(searchDocs?.inputSchema?.properties?.board);
    assert.ok(searchDocs?.inputSchema?.properties?.alt_queries);
    assert.ok(searchDocs?.inputSchema?.properties?.verbose);
    assert.ok(getPage?.inputSchema?.properties?.section);
    assert.ok(getPage?.inputSchema?.properties?.full);
    const manuals = await client.callTool('list_manuals', {});
    const manualText = JSON.stringify(manuals);
    assert.match(manualText, /rdk-x/);
    assert.match(manualText, /rdk-s/);
    const search = await client.callTool('search_docs', {
      query: '40pin',
      board: 'x5',
      limit: 1,
    });
    assert.notEqual(search.isError, true);
    const searchText = search.content?.find((block) => block.type === 'text')?.text ?? '';
    const parsed = JSON.parse(searchText);
    assert.equal(typeof parsed.noGoodMatch, 'boolean');
    assert.ok(Array.isArray(parsed.hits) && parsed.hits.length > 0);
    const hit = parsed.hits[0];
    assert.equal(typeof hit.title, 'string');
    assert.equal(typeof hit.url, 'string');
    assert.equal(typeof hit.snippet, 'string');
    assert.equal(hit.score, undefined);
    assert.equal(hit.role, undefined);
    console.log(
      `[mcp-rdk-docs-live] ${client.serverInfo?.version} tools: ${tools.map((tool) => tool.name).join(', ')}`
    );
  } finally {
    await client.close();
  }
});
