#!/usr/bin/env node
/**
 * D4 parity probe: `@server:uri` prompt mentions attach MCP resources.
 *
 * Covers the mention grammar (files/agents/Windows paths stay untouched), the
 * expansion rules (per-resource and total caps, failures become notes, one
 * failing resource never hides the rest), the live registry read path against
 * the mock stdio server, and the REPL-style failure when no MCP session exists.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'scripts/verify/fixtures/mcp-mock-server.mjs');
const mentions = await import(
  pathToFileURL(path.join(root, 'dist/cli/mcp-resource-mentions.js')).href
);
const { McpToolRegistry } = await import(
  pathToFileURL(path.join(root, 'dist/core/mcp/registry.js')).href
);

const { findMcpResourceMentions, expandMcpResourceMentions } = mentions;
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[mcp-resource-mentions] ok ${name}`);
};

// 1. Grammar: only `@server:scheme://...` is an MCP resource mention.
{
  const found = findMcpResourceMentions(
    'compare @mock:mock://doc/one with @src/app.ts and @agent-helper, also @C:\\tmp\\x and @mock:mock://doc/one again'
  );
  assert.deepEqual(
    found.map((mention) => `${mention.server}:${mention.uri}`),
    ['mock:mock://doc/one']
  );
  assert.equal(findMcpResourceMentions('no mentions here').length, 0);
  assert.equal(findMcpResourceMentions('@server:noscheme').length, 0);
  ok('mention grammar: server:scheme://uri only, deduped, files/agents/Windows paths untouched');
}

// 2. Trailing punctuation is not part of the URI.
{
  const [mention] = findMcpResourceMentions('read @mock:mock://doc/one.');
  assert.equal(mention.uri, 'mock://doc/one');
  ok('trailing sentence punctuation is stripped from the URI');
}

// 3. Expansion: blocks, notes, failure isolation, truncation, limits.
const reader = async (server, uri) => {
  if (server === 'broken') throw new Error('server is not connected');
  if (uri.endsWith('/big')) return { text: 'x'.repeat(9_000) };
  return { text: `content of ${server}:${uri}` };
};
{
  const one = await expandMcpResourceMentions('summarize @mock:mock://doc/one', { read: reader });
  assert.ok(one.extraContext?.includes('[mcp resource mock:mock://doc/one — attached'));
  assert.ok(one.extraContext?.includes('content of mock:mock://doc/one'));
  assert.equal(one.notes.length, 1);
  assert.ok(one.notes[0].includes('attached mock:mock://doc/one'));

  const mixed = await expandMcpResourceMentions('@mock:mock://a @broken:mock://b @mock:mock://c', {
    read: reader,
  });
  assert.ok(mixed.extraContext?.includes('content of mock:mock://a'));
  assert.ok(mixed.extraContext?.includes('content of mock:mock://c'));
  assert.ok(!mixed.extraContext?.includes('mock://b'));
  assert.ok(
    mixed.notes.some((line) => line.includes('mock://b not attached: server is not connected'))
  );
  ok('one failing resource is a note, and the healthy ones still attach');

  const big = await expandMcpResourceMentions('@mock:mock://big', { read: reader });
  assert.ok(big.extraContext);
  assert.ok(big.extraContext.includes('more chars truncated'));
  assert.ok(big.extraContext.length < 8_500);
  assert.ok(big.notes[0].includes('truncated'));

  const many = await expandMcpResourceMentions(
    '@mock:mock://1 @mock:mock://2 @mock:mock://3 @mock:mock://4',
    { read: reader }
  );
  assert.equal(many.notes.filter((line) => line.includes('attached mock:')).length, 3);
  assert.ok(many.notes.some((line) => line.includes('first 3 of 4')));

  const noSession = await expandMcpResourceMentions('@mock:mock://doc/one');
  assert.equal(noSession.extraContext, undefined);
  assert.ok(noSession.notes[0].includes('no MCP session is available'));
  ok('truncation, 3-resource cap and the no-session note keep the prompt bounded');
}

// 4. Live registry read: the real client/server path the CLI uses.
const registry = McpToolRegistry.connectInBackground(
  [
    {
      name: 'mock',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    },
  ],
  { registerTool: () => {}, onStatusChange: () => {} }
);
try {
  const read = await registry.readResourceText('mock', 'mock://doc/one');
  assert.equal(read.text, 'mock resource content');
  await assert.rejects(() => registry.readResourceText('mock', 'mock://missing'));
  await assert.rejects(
    () => registry.readResourceText('nope', 'mock://doc/one'),
    /Unknown MCP server/
  );
  const expanded = await expandMcpResourceMentions('quote @mock:mock://doc/one', {
    read: (server, uri) => registry.readResourceText(server, uri),
  });
  assert.ok(expanded.extraContext?.includes('mock resource content'));
  ok('registry.readResourceText reads the live mock server and errors honestly');
} finally {
  await registry.closeAll?.();
  await registry.dispose?.();
}

console.log(`[mcp-resource-mentions] ${checks}/5 checks passed`);
