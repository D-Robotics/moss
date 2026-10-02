#!/usr/bin/env node
/**
 * `moss mcp` lifecycle — add/list/remove/test write the same files the loader
 * reads; test performs a real initialize + tools/list; the registry heals a
 * dropped stdio server with one lazy reconnect.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildEntryFromArgv,
  renderMcpUsage,
  runMcpCommand,
  validateServerEntry,
} from '../dist/cli/mcp-commands.js';
import { loadMcpConfigs } from '../dist/cli/mcp-config.js';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stdioServerPath = path.join(here, 'fixtures', 'mcp-stdio-server.mjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cmd-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cmd-ws-'));
const ctx = { workspaceDir: ws, configDir: home };

const stdout = [];
const stderr = [];
const prevOut = process.stdout.write.bind(process.stdout);
const prevErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk) => {
  stdout.push(String(chunk));
  return true;
};
process.stderr.write = (chunk) => {
  stderr.push(String(chunk));
  return true;
};
try {
  // ─── argv → entry parsing (incl. ${ENV_VAR} passthrough) ─────────────────
  assert.deepStrictEqual(buildEntryFromArgv(['node', 'server.mjs', '--port', '9']), {
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs', '--port', '9'],
  });
  const httpEntry = buildEntryFromArgv([
    'https://mcp.example.com/mcp',
    '--header',
    'Authorization=Bearer ${MY_TOKEN}',
  ]);
  assert.equal(httpEntry.transport, 'http');
  assert.equal(httpEntry.headers.Authorization, 'Bearer ${MY_TOKEN}');
  assert.ok(!('args' in httpEntry), 'http entries carry no args');

  assert.ok(validateServerEntry('ok.name-1', { command: 'node' }) === undefined);
  assert.ok(validateServerEntry('bad name!', { command: 'x' }) !== undefined);
  assert.ok(validateServerEntry('s', { transport: 'http' }) !== undefined, 'http needs url');
  assert.ok(validateServerEntry('s', {}) !== undefined, 'stdio needs command');

  // ─── add → file → loader roundtrip ───────────────────────────────────────
  let code = await runMcpCommand(['add', 'fixture', process.execPath, stdioServerPath], ctx);
  assert.equal(code, 0, 'add exits 0');
  const userFile = path.join(home, 'mcp.json');
  const written = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.equal(written.mcpServers.fixture.transport, 'stdio');
  assert.equal(written.mcpServers.fixture.command, process.execPath);

  const loaded = loadMcpConfigs(ws, home, {});
  assert.equal(loaded.length, 1, 'the loader sees the added server');
  assert.equal(loaded[0].name, 'fixture');

  code = await runMcpCommand(['add', 'fixture', 'x'], ctx);
  assert.equal(code, 1, 'duplicate add refuses');
  code = await runMcpCommand(['add', 'http1', 'https://example.com/mcp'], ctx);
  assert.equal(code, 0, 'http add works');

  // ─── list ────────────────────────────────────────────────────────────────
  stdout.length = 0;
  code = await runMcpCommand(['list'], ctx);
  assert.equal(code, 0);
  const listText = stdout.join('');
  assert.ok(listText.includes('fixture'), 'list names the stdio server');
  assert.ok(listText.includes('http1'), 'list names the http server');

  // ─── test: real initialize + tools/list over stdio ───────────────────────
  stdout.length = 0;
  stderr.length = 0;
  code = await runMcpCommand(['test', 'fixture'], ctx);
  assert.equal(code, 0, `test connects: ${stderr.join('')}`);
  assert.ok(stdout.join('').includes('connected'), 'test reports connected + tools');

  code = await runMcpCommand(['test', 'nope'], ctx);
  assert.equal(code, 1, 'unknown server fails with a pointer');

  // ─── remove ──────────────────────────────────────────────────────────────
  code = await runMcpCommand(['remove', 'http1'], ctx);
  assert.equal(code, 0);
  const after = loadMcpConfigs(ws, home, {});
  assert.ok(!after.some((c) => c.name === 'http1'), 'removed server is gone');
  assert.ok(
    after.some((c) => c.name === 'fixture'),
    'other servers survive'
  );
  code = await runMcpCommand(['remove', 'http1'], ctx);
  assert.equal(code, 1, 'removing again fails');

  // ─── project scope ───────────────────────────────────────────────────────
  code = await runMcpCommand(
    ['add', '--project', 'ws-server', process.execPath, stdioServerPath],
    ctx
  );
  assert.equal(code, 0);
  const projectFile = path.join(ws, '.moss', 'mcp.json');
  assert.ok(fs.existsSync(projectFile), '--project writes .moss/mcp.json');
  const merged = loadMcpConfigs(ws, home, {});
  assert.ok(
    merged.some((c) => c.name === 'ws-server'),
    'project server loads'
  );

  // ─── lazy reconnect: an unexpected drop ('failed') heals; explicit close
  // stays closed ───────────────────────────────────────────────────────────
  const registered = new Map();
  const registry = await McpToolRegistry.connectAll(
    [
      {
        name: 'fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioServerPath],
      },
    ],
    { registerTool: (tool) => registered.set(tool.name, tool) }
  );
  assert.equal(registry.getStatuses()[0].state, 'connected');

  // Explicit closeAll: a closed server must refuse (no silent zombie calls).
  const searchTool = registry.getSearchTool('fixture');
  assert.ok(searchTool, 'search tool exists');
  await registry.closeAll();
  assert.equal(registry.getStatuses()[0].state, 'closed');
  await assert.rejects(() => searchTool.execute({}, {}), /not callable/);

  // Unexpected drop: an entry stuck in 'failed' heals on the next search —
  // drive the private reconnect path directly (mjs: no access modifier).
  const registry2 = await McpToolRegistry.connectAll(
    [
      {
        name: 'fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioServerPath],
      },
    ],
    { registerTool: (tool) => registered.set(tool.name, tool) }
  );
  assert.equal(registry2.getStatuses()[0].state, 'connected');
  // White-box: flip the entry to 'failed' (the state an unexpected drop
  // produces) and confirm the search tool's guard heals it.
  const entries = registry2.entries;
  assert.ok(entries, 'internal entries accessible from spec js');
  entries[0].status.state = 'failed';
  const healedSearch = registry2.getSearchTool('fixture');
  assert.ok(healedSearch, 'search tool survives the drop');
  const result = await healedSearch.execute({ query: '' }, {});
  assert.ok(String(result).includes('fixture'), 'search answers after reconnect');
  assert.equal(registry2.getStatuses()[0].state, 'connected', 'status healed to connected');

  // ─── zh locale: usage + command output render in Chinese ─────────────────
  const savedLang = process.env.LANG;
  const savedLcAll = process.env.LC_ALL;
  try {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';

    stdout.length = 0;
    code = await runMcpCommand(['list'], ctx);
    assert.equal(code, 0);
    const zhList = stdout.join('');
    assert.ok(zhList.includes('fixture'), 'zh list still names the server');
    assert.ok(zhList.includes('个服务器'), 'zh list footer counts in Chinese');

    stderr.length = 0;
    code = await runMcpCommand(['test', 'nope'], ctx);
    assert.equal(code, 1);
    assert.ok(stderr.join('').includes('未配置'), 'zh test error names the state');

    stdout.length = 0;
    code = await runMcpCommand(['add', 'zhcheck', process.execPath, stdioServerPath], ctx);
    assert.equal(code, 0, 'zh add succeeds');
    assert.ok(stdout.join('').includes('已添加'), 'zh add success message');
    code = await runMcpCommand(['remove', 'zhcheck'], ctx);
    assert.equal(code, 0, 'cleanup zhcheck');

    assert.ok(renderMcpUsage(true).includes('用法'), 'zh usage header');
    assert.ok(!renderMcpUsage(true).includes('Usage:'), 'zh usage drops the English header');
    assert.ok(renderMcpUsage(false).includes('Usage:'), 'en usage header');
  } finally {
    if (savedLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = savedLcAll;
    if (savedLang === undefined) delete process.env.LANG;
    else process.env.LANG = savedLang;
  }
} finally {
  process.stdout.write = prevOut;
  process.stderr.write = prevErr;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('[PASS] mcp lifecycle (add/list/remove/test + lazy reconnect)');
// The stdio fixture's child-process handle can outlive the assertions (a
// detached IPC socket); the runner must not wait on it.
process.exit(0);
