#!/usr/bin/env node
/**
 * preinstall refuses Node older than 22.16 and prints upgrade steps.
 * On a supported Node the script exits 0, so npm ci keeps going.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'scripts', 'check-node-version.cjs');
const require = createRequire(import.meta.url);
const { nodeIsSupported, upgradeMessage } = require(script);

assert.equal(nodeIsSupported('22.16.0'), true);
assert.equal(nodeIsSupported('v22.16.0'), true);
assert.equal(nodeIsSupported('24.0.0'), true);
assert.equal(nodeIsSupported('22.15.9'), false);
assert.equal(nodeIsSupported('18.20.0'), false);
assert.equal(nodeIsSupported('20.18.0'), false);

const message = upgradeMessage('18.20.0');
assert.match(message, /Node >= 22\.16/);
assert.match(message, /Node 18\.20\.0/);
assert.match(message, /nvm install 22/);
assert.match(
  message,
  /NVM_NODEJS_ORG_MIRROR=https:\/\/npmmirror\.com\/mirrors\/node nvm install 22/
);

const ok = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
assert.equal(ok.status, 0, ok.stderr);
assert.equal(ok.stderr, '');

console.log('[PASS] node version preinstall');
