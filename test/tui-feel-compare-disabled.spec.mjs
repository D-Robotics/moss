#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-feel-compare-'));
  try {
    const scripts = path.join(sandbox, 'scripts/tui-feel');
    const fakeBin = path.join(sandbox, 'bin');
    const sentinel = path.join(sandbox, 'spawned');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(fakeBin);
    for (const name of ['run.mjs', 'compare_feel.py']) {
      fs.copyFileSync(path.join(root, 'scripts/tui-feel', name), path.join(scripts, name));
    }
    fs.writeFileSync(path.join(sandbox, '.env'), 'MOSS_FALLBACK_PROVIDERS=synthetic-only\n');
    for (const name of ['python3', 'node', 'claude']) {
      fs.writeFileSync(
        path.join(fakeBin, name),
        '#!/bin/sh\nprintf "invoked\\n" >> "$MOSS_TEST_SPAWNED"\nexit 1\n',
        { mode: 0o755 }
      );
    }
    const env = { HOME: sandbox, PATH: fakeBin, MOSS_TEST_SPAWNED: sentinel };
    for (const args of [['--compare', 'claude'], ['--compare=claude']]) {
      const result = spawnSync(process.execPath, [path.join(scripts, 'run.mjs'), ...args], {
        cwd: sandbox,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.notEqual(result.status, 0, 'comparison must fail closed');
      assert.match(`${result.stdout}${result.stderr}`, /comparison.*disabled/i);
      assert.equal(fs.existsSync(sentinel), false, 'comparison must not spawn any program');
      assert.equal(fs.existsSync(path.join(sandbox, 'bench/results')), false);
    }
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(python.status, 0);
    for (const args of [[], ['--compare', 'claude']]) {
      const direct = spawnSync(
        python.stdout.trim(),
        ['-S', path.join(scripts, 'compare_feel.py'), ...args],
        {
          cwd: sandbox,
          env,
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      assert.notEqual(direct.status, 0);
      assert.match(`${direct.stdout}${direct.stderr}`, /comparison.*disabled/i);
      assert.equal(fs.existsSync(sentinel), false, 'direct invocation must not spawn any program');
    }
    console.log('[PASS] legacy comparison fails before spawning with a synthetic install .env');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
