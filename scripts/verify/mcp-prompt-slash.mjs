#!/usr/bin/env node
/**
 * D4 parity probe: MCP prompts are user-invocable, not only model-invocable.
 *
 * Claude Code exposes each MCP prompt as a first-class slash command; Moss keeps
 * them under `/mcp` so a server cannot grow the slash namespace. This probe pins
 * both halves against the real registry + real slash dispatcher:
 *
 *   - `McpToolRegistry.promptCatalog()` lists templates from connected servers
 *     and records a broken server as a failure row instead of hiding the rest;
 *   - `expandPrompt()` renders `prompts/get` messages into the text a turn gets;
 *   - `/mcp prompts` and `/mcp prompt <server> <name> k=v` go through
 *     `runRegistryCommand` (the same dispatcher the REPL and TUI use), with
 *     `requiresArgs` leaving bare `/mcp` to the host's status panel;
 *   - bad input (unknown server/prompt, non key=value argument) fails with a
 *     message instead of submitting an empty turn.
 *
 * No network: the fixture is scripts/verify/fixtures/mcp-mock-server.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'scripts/verify/fixtures/mcp-mock-server.mjs');
const { McpToolRegistry } = await import(
  pathToFileURL(path.join(root, 'dist/core/mcp/registry.js')).href
);
const { runRegistryCommand, findRegistryCommand } = await import(
  pathToFileURL(path.join(root, 'dist/cli/commands/registry.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[mcp-prompt-slash] ok ${name}`);
};

const mock = {
  name: 'mock',
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
};
const broken = {
  name: 'broken',
  transport: 'stdio',
  command: process.execPath,
  args: [path.join(root, 'scripts/verify/fixtures/does-not-exist.mjs')],
};

const registry = await McpToolRegistry.connectAll([mock, broken], {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 15_000,
});

try {
  // 1. Catalog: the healthy server's template is listed, the broken one is a row.
  const catalog = await registry.promptCatalog();
  const greet = catalog.prompts.find((entry) => entry.server === 'mock' && entry.name === 'greet');
  assert.ok(greet, 'mock/greet must appear in the catalog');
  assert.equal(greet.arguments[0]?.name, 'who');
  assert.equal(greet.arguments[0]?.required, true);
  assert.equal(catalog.failures.length, 1, 'the broken server must be one failure row');
  assert.equal(catalog.failures[0].server, 'broken');
  ok('promptCatalog lists templates and keeps a broken server as a failure row');

  // 2. Expansion renders the prompts/get messages into turn text.
  const expanded = await registry.expandPrompt('mock', 'greet', { who: 'Ada' });
  assert.equal(expanded.text, 'user:\nHello Ada');
  assert.equal(expanded.messages, 1);
  ok('expandPrompt renders prompts/get messages for a turn');

  // 3. Unknown server / unknown prompt are errors, not empty turns.
  await assert.rejects(registry.expandPrompt('nope', 'greet', {}), /Unknown MCP server "nope"/);
  await assert.rejects(registry.expandPrompt('mock', 'not-a-prompt', {}));
  ok('unknown server and unknown prompt reject instead of submitting empty text');

  // 4. Slash dispatch through the shared registry command.
  const said = [];
  let submitted = null;
  const ctx = {
    agent: { config: {}, tools: { getAll: () => [] } },
    runtime: {
      mcpPrompts: {
        catalog: () => registry.promptCatalog(),
        expand: (server, name, args) => registry.expandPrompt(server, name, args),
      },
    },
    sessionKey: 'probe',
    workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-prompt-slash-')),
    surface: 'repl',
    say: (kind, text) => said.push({ kind, text }),
    prefillInput: () => {},
    submitPrompt: (text) => {
      submitted = text;
    },
  };

  assert.equal(findRegistryCommand('/mcp'), null, 'bare /mcp stays with the host status panel');
  assert.equal(await runRegistryCommand('/mcp prompts', ctx), true);
  const listed = said.map((entry) => entry.text).join('\n');
  assert.match(listed, /mock\/greet \(who\)/);
  assert.match(listed, /broken: prompts unavailable/);
  assert.match(listed, /\/mcp prompt <server> <name> key=value/);
  ok('/mcp prompts lists templates and failure rows');

  said.length = 0;
  assert.equal(await runRegistryCommand('/mcp prompt mock greet who=Ada', ctx), true);
  assert.equal(submitted, 'user:\nHello Ada', 'the expanded prompt becomes the turn');
  assert.match(
    said.map((entry) => entry.text).join('\n'),
    /Running MCP prompt "greet" from "mock"/
  );
  ok('/mcp prompt submits the expanded template as a turn');

  said.length = 0;
  submitted = null;
  await runRegistryCommand('/mcp prompt mock', ctx);
  assert.equal(submitted, null, 'missing name/subcommand must not submit a turn');
  assert.match(said.map((entry) => entry.text).join('\n'), /Usage:/);
  ok('/mcp prompt without a name prints usage instead of submitting');

  said.length = 0;
  submitted = null;
  await runRegistryCommand('/mcp prompt mock greet who', ctx);
  assert.equal(submitted, null, 'a malformed argument must not submit a turn');
  assert.match(said.map((entry) => entry.text).join('\n'), /not key=value/);
  ok('/mcp prompt rejects a non key=value argument');

  said.length = 0;
  submitted = null;
  await runRegistryCommand('/mcp prompt mock not-a-prompt', ctx);
  assert.equal(submitted, null, 'a failed expansion must not submit a turn');
  assert.match(said.map((entry) => entry.text).join('\n'), /not-a-prompt|unknown prompt/i);
  ok('/mcp prompt reports a failed expansion instead of a turn');

  said.length = 0;
  assert.equal(await runRegistryCommand('/mcp list', ctx), true);
  assert.match(said.map((entry) => entry.text).join('\n'), /mock\/greet/);
  ok('/mcp list is an alias for /mcp prompts');

  fs.rmSync(ctx.workspace, { recursive: true, force: true });
  console.log(`[mcp-prompt-slash] ${checks}/${checks} checks passed`);
} finally {
  await registry.closeAll();
}
