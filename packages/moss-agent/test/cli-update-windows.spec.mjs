#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runCliUpdate } from '../dist/cli/update.js';

test('CLI update resolves the npm command shim on Windows', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cli-update-'));
  const npmShim = path.join(tempDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  fs.writeFileSync(
    npmShim,
    process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
    'utf8'
  );
  if (process.platform !== 'win32') fs.chmodSync(npmShim, 0o755);

  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ version: '999.0.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.PATH = tempDir;

  try {
    const exitCode = await runCliUpdate({
      configDir: path.join(tempDir, 'config'),
      currentVersion: '999.0.0',
    });
    assert.equal(exitCode, 0, 'the platform npm shim should execute successfully');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
