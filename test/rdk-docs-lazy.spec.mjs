#!/usr/bin/env node
/**
 * Built-in rdk-docs declares its search tool immediately and does not spawn
 * until startDeferred, waitForConnections, or the first tool call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';
import { builtinRdkDocsServerConfig } from '../dist/core/mcp/rdk-docs.js';

function markerServer(dir) {
  const marker = path.join(dir, 'started');
  const script = path.join(dir, 'srv.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, '1');\n`
  );
  return { marker, script };
}

test('builtin rdk-docs defers start and keeps the npx constraints', () => {
  const config = builtinRdkDocsServerConfig();
  assert.equal(config.deferStart, true);
  assert.equal(config.startupEnvOnly, true);
  assert.equal(config.args.includes('--registry'), false);
  assert.equal(config.args.includes('--ignore-scripts'), true);
  assert.ok(config.cwd?.includes(`${path.sep}.moss${path.sep}cache${path.sep}npx${path.sep}`));
});

test('deferStart does not spawn until startDeferred', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rdk-lazy-'));
  const { marker, script } = markerServer(dir);
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'rdk-docs',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      deferStart: true,
    },
  ]);
  try {
    assert.equal(registry.getStatuses()[0].state, 'deferred');
    assert.equal(registry.getTools()[0].name, 'mcp__rdk-docs__search');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fs.existsSync(marker), false);
    registry.startDeferred('rdk-docs');
    await registry.waitForConnections();
    assert.equal(fs.existsSync(marker), true);
  } finally {
    await registry.closeAll();
  }
});

test('closeAll on a deferred server does not spawn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rdk-close-'));
  const { marker, script } = markerServer(dir);
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'rdk-docs',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      deferStart: true,
    },
  ]);
  await registry.closeAll();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(registry.getStatuses()[0].state, 'closed');
});

test('a deferred server that never connects fails once and does not leave a child', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rdk-hang-'));
  const pidFile = path.join(dir, 'pid');
  const script = path.join(dir, 'hang.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`
  );
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'rdk-docs',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      deferStart: true,
      connectTimeoutMs: 400,
    },
  ]);
  const started = Date.now();
  let caught;
  try {
    await registry.getTools()[0].execute({ query: 'pinout' }, {});
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - started;
  try {
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /did not start/);
    assert.doesNotMatch(caught.message, /connection dropped/);
    assert.ok(elapsed < 3_000, `lazy start took ${elapsed}ms`);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 1_500;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, 'failed lazy start left a child process');
  } finally {
    await registry.closeAll();
  }
});

test('the search tool starts a deferred server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rdk-search-'));
  const { marker, script } = markerServer(dir);
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'rdk-docs',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      deferStart: true,
      connectTimeoutMs: 2_000,
    },
  ]);
  try {
    await registry
      .getTools()[0]
      .execute({}, {})
      .catch(() => undefined);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    await registry.closeAll();
  }
});

test('a server without deferStart still connects in the background', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rdk-eager-'));
  const { marker, script } = markerServer(dir);
  const registry = McpToolRegistry.connectInBackground([
    {
      name: 'other',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
    },
  ]);
  try {
    assert.equal(registry.getStatuses()[0].state, 'connecting');
    await registry.waitForConnections();
    assert.equal(fs.existsSync(marker), true);
  } finally {
    await registry.closeAll();
  }
});
