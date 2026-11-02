#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePyLayout } from './helpers/require-pyte.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' && requirePyLayout('tui-feel-fallback')) {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-feel-synthetic-install-'));
  try {
    const copyOptions = {
      recursive: true,
      filter: (source) => path.basename(source).toLowerCase() !== '.env',
    };
    fs.cpSync(path.join(root, 'dist'), path.join(install, 'dist'), copyOptions);
    fs.cpSync(path.join(root, 'bin'), path.join(install, 'bin'), copyOptions);
    fs.cpSync(
      path.join(root, 'scripts/tui-feel'),
      path.join(install, 'scripts/tui-feel'),
      copyOptions
    );
    fs.copyFileSync(path.join(root, 'package.json'), path.join(install, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(install, 'node_modules'), 'dir');
    const result = spawnSync(
      'python3',
      [path.join(root, 'test/fixtures/tui-feel-fallback.py'), install, process.env.PATH ?? ''],
      { cwd: install, encoding: 'utf8', timeout: 60_000 }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
}
