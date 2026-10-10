#!/usr/bin/env node
/**
 * Temporary HOME directories are removed when the process that created them
 * exits. The suite runner counts the same directories before and after.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listMossTempHomes, sweepStaleTestRuns, trackTempDir } from './helpers/temp-home.mjs';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'temp-home.mjs');
const helperUrl = pathToFileURL(helper).href;

const before = new Set(listMossTempHomes());
const probe = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-notice-probe-')));
fs.mkdirSync(path.join(probe, '.config', 'moss'), { recursive: true });
fs.writeFileSync(path.join(probe, '.config', 'moss', 'config.json'), '{}\n');
const during = listMossTempHomes().filter((dir) => !before.has(dir));
assert.ok(during.includes(probe), `probe home is visible to the suite check: ${during.join(', ')}`);

const childHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-save-key-child-'));
fs.mkdirSync(path.join(childHome, '.config', 'moss'), { recursive: true });
fs.writeFileSync(path.join(childHome, '.config', 'moss', 'config.json'), '{}\n');
const child = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    [
      `import { trackTempDir } from ${JSON.stringify(helperUrl)};`,
      `trackTempDir(${JSON.stringify(childHome)});`,
    ].join('\n'),
  ],
  { encoding: 'utf8' }
);
assert.equal(child.status, 0, child.stderr || child.stdout);
assert.equal(fs.existsSync(childHome), false, 'a tracked temp home is removed on exit');

{
  const parent = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-scan-parent-')));
  const run = fs.mkdtempSync(path.join(parent, 'run-'));
  const inside = path.join(run, 'moss-notice-inside-');
  const outside = fs.mkdtempSync(path.join(parent, 'moss-notice-outside-'));
  fs.mkdirSync(path.join(inside, '.config', 'moss'), { recursive: true });
  fs.writeFileSync(path.join(inside, '.config', 'moss', 'config.json'), '{}\n');
  fs.mkdirSync(path.join(outside, '.config', 'moss'), { recursive: true });
  fs.writeFileSync(path.join(outside, '.config', 'moss', 'config.json'), '{}\n');
  assert.deepEqual(listMossTempHomes(run), [inside]);
  assert.equal(listMossTempHomes(run).includes(outside), false);

  const stale = fs.mkdtempSync(path.join(parent, 'moss-test-run-'));
  const fresh = fs.mkdtempSync(path.join(parent, 'moss-test-run-'));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const removed = sweepStaleTestRuns(parent);
  assert.ok(removed.includes(stale), 'an idle test-run root is swept');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'a fresh test-run root stays');
}

console.log('[PASS] temp-home');
