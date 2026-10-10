#!/usr/bin/env node
/**
 * preinstall refuses Node older than 22.16 and prints upgrade steps.
 * On a supported Node the script exits 0, so npm ci keeps going.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'scripts', 'check-node-version.cjs');
const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
assert.match(npmrc, /^engine-strict=true$/m);
const require = createRequire(import.meta.url);
const { nodeIsSupported, upgradeMessage } = require(script);

assert.equal(nodeIsSupported('22.16.0'), true);
assert.equal(nodeIsSupported('22.16'), true);
assert.equal(nodeIsSupported('v22.16.0'), true);
assert.equal(nodeIsSupported('24.0.0'), true);
assert.equal(nodeIsSupported('24'), true);
assert.equal(nodeIsSupported('22.15.9'), false);
assert.equal(nodeIsSupported('22.15'), false);
assert.equal(nodeIsSupported('18.20.0'), false);
assert.equal(nodeIsSupported('20.18.0'), false);
assert.equal(nodeIsSupported('20.19'), false);
assert.equal(nodeIsSupported('20.19.0'), false);

const message = upgradeMessage('18.20.0');
assert.match(message, /Node >= 22\.16/);
assert.match(message, /Node 18\.20\.0/);
assert.match(message, /nvm install 22/);
assert.match(
  message,
  /curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.3\/install\.sh \| bash/
);
assert.match(message, /\. ~\/\.nvm\/nvm\.sh/);
assert.match(message, /nvm install 22 && nvm use 22/);
assert.match(message, /curl -fsSL https:\/\/fnm\.vercel\.app\/install \| bash/);
assert.match(message, /fnm install 22 && fnm use 22/);
assert.match(message, /winget install OpenJS\.NodeJS\.LTS/);
assert.match(message, /winget install Schniz\.fnm/);
assert.match(message, /npm ci/);
assert.match(
  message,
  /NVM_NODEJS_ORG_MIRROR=https:\/\/npmmirror\.com\/mirrors\/node nvm install 22/
);

const ok = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
assert.equal(ok.status, 0, ok.stderr);
assert.equal(ok.stderr, '');

console.log('[PASS] node version preinstall');
