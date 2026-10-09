#!/usr/bin/env node
/**
 * Empty-composer placeholder follows the workspace: board, code, or neither.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BOARD_COMPOSER_PLACEHOLDER,
  CODE_COMPOSER_PLACEHOLDER,
  GENERAL_COMPOSER_PLACEHOLDER,
  composerPlaceholder,
  detectComposerProjectKind,
} from '../dist/cli/composer-placeholder.js';
import { setTuiLocale, tui } from '../dist/cli/tui/copy.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-placeholder-'));
}

{
  const dir = tempDir();
  try {
    assert.equal(
      detectComposerProjectKind({ workspaceDir: dir, env: {} }),
      'general',
      'an empty folder is not a board project'
    );
    assert.equal(composerPlaceholder('general'), GENERAL_COMPOSER_PLACEHOLDER);
    assert.ok(!GENERAL_COMPOSER_PLACEHOLDER.includes('camera'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    assert.equal(
      detectComposerProjectKind({ workspaceDir: dir, env: {} }),
      'code',
      'package.json is a code project'
    );
    assert.equal(composerPlaceholder('code'), CODE_COMPOSER_PLACEHOLDER);
    assert.ok(!CODE_COMPOSER_PLACEHOLDER.includes('camera'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, '.moss'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    fs.writeFileSync(
      path.join(dir, '.moss', 'devices.json'),
      `${JSON.stringify({
        devices: [{ deviceId: 'board-1', kind: 'linux', host: '10.0.0.8' }],
      })}\n`
    );
    assert.equal(
      detectComposerProjectKind({ workspaceDir: dir, env: {} }),
      'board',
      'a saved device wins over a code marker'
    );
    assert.equal(composerPlaceholder('board'), BOARD_COMPOSER_PLACEHOLDER);
    assert.equal(
      detectComposerProjectKind({ workspaceDir: dir, env: { MOSS_DEVICE_HOST: '10.0.0.9' } }),
      'board'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tempDir();
  try {
    assert.equal(
      detectComposerProjectKind({
        workspaceDir: dir,
        env: { MOSS_DEVICE_HOST: '10.1.2.3' },
      }),
      'board',
      'MOSS_DEVICE_HOST marks a board session even with no project files'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  setTuiLocale(true);
  assert.match(tui(CODE_COMPOSER_PLACEHOLDER), /试试/);
  assert.match(tui(GENERAL_COMPOSER_PLACEHOLDER), /试试/);
  assert.match(tui(BOARD_COMPOSER_PLACEHOLDER), /试试/);
  setTuiLocale(false);
  assert.equal(tui(CODE_COMPOSER_PLACEHOLDER), CODE_COMPOSER_PLACEHOLDER);
}

console.log('[PASS] composer placeholder by project type');
