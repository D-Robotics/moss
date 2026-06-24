#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/cli-update-check.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForCliUpdate,
  formatUpdateNotice,
  shouldSkipCliUpdateCheck,
  startCliUpdateCheck,
} from '../dist/cli/update-check.js';
import { completeInteractiveCommand } from '../dist/cli/repl.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-update-check-'));
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000,
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 }),
  });
  assert.equal(notice?.latestVersion, '0.3.5');
  assert.match(formatUpdateNotice(notice), /0\.3\.4 -> 0\.3\.5/);
  assert.match(formatUpdateNotice(notice), /npm i -g @rdk-moss\/agent@latest/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'latest-version.json'), 'utf-8')).latestVersion, '0.3.5');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.6' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.7' }), { status: 200 });
    },
  });
  assert.equal(calls, 0);
  assert.equal(notice?.latestVersion, '0.3.6');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.1' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 });
    },
  });
  assert.equal(calls, 1, 'cache older than current install should not suppress registry checks');
  assert.equal(notice?.latestVersion, '0.3.5');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.4' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    noUpdateCacheMaxAgeMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 });
    },
  });
  assert.equal(calls, 1, 'expired no-update cache should refresh quickly after new releases');
  assert.equal(notice?.latestVersion, '0.3.5');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.4' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    noUpdateCacheMaxAgeMs: 5 * 60 * 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 });
    },
  });
  assert.equal(calls, 0, 'fresh no-update cache should still avoid registry checks');
  assert.equal(notice, null);
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.5',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(notice, null);
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.5',
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 }),
  });
  assert.equal(notice, null);
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.6',
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 }),
  });
  assert.equal(notice, null);
}

{
  // /upgrade was curated out of the surface (updates are out-of-band: npm/installer),
  // so `/up` matches nothing and falls back to the focused default command list.
  const [matches] = completeInteractiveCommand('/up');
  assert.ok(matches.includes('/status'), 'fallback completion returns the focused default command list');
  assert.ok(!matches.includes('/upgrade'), '/upgrade is de-surfaced and should not appear in completion');
}

{
  assert.equal(shouldSkipCliUpdateCheck({ MOSS_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(shouldSkipCliUpdateCheck({ MOSS_NO_UPDATE_CHECK: 'true' }), true);
  assert.equal(shouldSkipCliUpdateCheck({ MOSS_NO_UPDATE_CHECK: 'yes' }), true);
  assert.equal(shouldSkipCliUpdateCheck({ MOSS_NO_UPDATE_CHECK: '0' }), false);
  assert.equal(shouldSkipCliUpdateCheck({}), false);
}

{
  const previous = process.env.MOSS_NO_UPDATE_CHECK;
  process.env.MOSS_NO_UPDATE_CHECK = '1';
  let calls = 0;
  let notices = 0;
  try {
    startCliUpdateCheck({
      configDir: tmpDir(),
      currentVersion: '0.3.4',
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 });
      },
      onNotice: () => {
        notices += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 0, 'MOSS_NO_UPDATE_CHECK should skip registry fetch at the runtime entry point');
    assert.equal(notices, 0, 'MOSS_NO_UPDATE_CHECK should not emit update notices');
  } finally {
    if (previous === undefined) {
      delete process.env.MOSS_NO_UPDATE_CHECK;
    } else {
      process.env.MOSS_NO_UPDATE_CHECK = previous;
    }
  }
}

console.log('[PASS] CLI update check is cached, quiet on failure, and default completion stays focused');
