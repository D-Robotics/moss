#!/usr/bin/env node
/**
 * Opt-in install of the documented source commands into a temp prefix.
 * Off unless MOSS_INSTALL_E2E=1: npm ci (which builds via prepare) is too slow
 * for the default suite.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceInstallCommands } from '../dist/cli/update-command.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.env.MOSS_INSTALL_E2E !== '1') {
  console.log(
    '[package-install-e2e] skip: set MOSS_INSTALL_E2E=1 to install into a temp prefix and run moss --version'
  );
} else {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const documented = sourceInstallCommands(pkg.repository);
  assert.deepEqual(documented.slice(2), ['npm ci', 'npm install -g --install-links .']);
  assert.ok(!documented.includes('npm run build'), 'prepare already builds during npm ci');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-install-e2e-'));
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'prefix');
  const src = path.join(root, 'src');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), '');
  fs.writeFileSync(path.join(home, 'etc-npmrc'), '');

  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: os.tmpdir(),
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    npm_config_cache: path.join(root, 'cache'),
    npm_config_prefix: prefix,
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_globalconfig: path.join(home, 'etc-npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  if (process.env.COMSPEC) env.COMSPEC = process.env.COMSPEC;

  const shell = process.platform === 'win32';

  function run(command, args, cwd) {
    return spawnSync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 600_000,
      shell,
    });
  }

  try {
    const clone = spawnSync('git', ['clone', '--local', repoRoot, src], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(clone.status, 0, `git clone failed\n${clone.stderr}`);

    for (const step of documented.slice(2)) {
      const parts = step.split(' ');
      const result = run(parts[0], parts.slice(1), src);
      assert.equal(
        result.status,
        0,
        `${step} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
      );
    }

    const bin =
      process.platform === 'win32'
        ? path.join(prefix, 'moss.cmd')
        : path.join(prefix, 'bin', 'moss');
    assert.ok(fs.existsSync(bin), `missing moss bin at ${bin}`);
    const version = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      env,
      shell,
    });
    assert.equal(version.status, 0, version.stderr);
    const versionPattern = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      version.stdout,
      new RegExp(`^moss v${versionPattern} \\([0-9a-f]{7,40}, \\d{4}-\\d{2}-\\d{2}\\)`)
    );

    const resolvedPrefix = fs.realpathSync(prefix) + path.sep;
    const target = fs.realpathSync(bin);
    assert.ok(
      target.startsWith(resolvedPrefix),
      `moss bin resolves outside the prefix (${target})`
    );
    console.log(`[PASS] package install e2e: ${version.stdout.trim()} (${target})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
