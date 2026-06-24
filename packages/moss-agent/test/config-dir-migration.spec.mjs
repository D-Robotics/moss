#!/usr/bin/env node
/**
 * Config-dir rename with back-compat: new installs use ~/.config/moss, but an
 * existing legacy ~/.config/dmoss is kept until ~/.config/moss is created, so
 * upgrading never orphans a user's config. Explicit MOSS_CONFIG_DIR still
 * overrides everything.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigDir } from '../dist/cli/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfgdir-'));
try {
  // Explicit override wins on every platform.
  assert.equal(
    resolveConfigDir({ MOSS_CONFIG_DIR: path.join(tmp, 'explicit') }),
    path.join(tmp, 'explicit'),
    'explicit MOSS_CONFIG_DIR is honored verbatim',
  );

  // The default/legacy-fallback path uses XDG on POSIX (APPDATA on win32).
  if (process.platform !== 'win32') {
    const xdg = path.join(tmp, 'xdg');
    fs.mkdirSync(xdg, { recursive: true });

    // 1. Fresh install: neither dir exists yet -> new 'moss'.
    assert.equal(resolveConfigDir({ XDG_CONFIG_HOME: xdg }), path.join(xdg, 'moss'), 'fresh install resolves to moss');

    // 2. Legacy ~/.config/dmoss present, moss absent -> keep dmoss (no orphaning).
    fs.mkdirSync(path.join(xdg, 'dmoss'), { recursive: true });
    assert.equal(
      resolveConfigDir({ XDG_CONFIG_HOME: xdg }),
      path.join(xdg, 'dmoss'),
      'legacy dmoss kept when moss absent',
    );

    // 3. Once ~/.config/moss exists it wins, even if dmoss also exists.
    fs.mkdirSync(path.join(xdg, 'moss'), { recursive: true });
    assert.equal(resolveConfigDir({ XDG_CONFIG_HOME: xdg }), path.join(xdg, 'moss'), 'moss wins once created');
  }

  console.log('[PASS] config-dir: moss default + legacy dmoss back-compat + explicit override');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
