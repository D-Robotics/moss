#!/usr/bin/env node
/**
 * preinstall / prepare refuse Node older than 22.16 and print upgrade steps
 * for macOS / Ubuntu / Windows plus the npm i -g success path.
 * On a supported Node the script exits 0, so npm ci keeps going.
 * MOSS_TEST_FAKE_NODE_VERSION exercises the failure path without an old Node.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'scripts', 'check-node-version.cjs');
const require = createRequire(import.meta.url);
const { nodeIsSupported, upgradeMessage } = require(script);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.equal(nodeIsSupported('22.16.0'), true);
assert.equal(nodeIsSupported('v22.16.0'), true);
assert.equal(nodeIsSupported('24.0.0'), true);
assert.equal(nodeIsSupported('22.15.9'), false);
assert.equal(nodeIsSupported('18.20.0'), false);
assert.equal(nodeIsSupported('20.18.0'), false);

const message = upgradeMessage('18.20.0', { LC_ALL: 'C', LANG: 'en_US.UTF-8' });
assert.match(message, /Node >= 22\.16/);
assert.match(message, /Node 18\.20\.0/);
assert.match(message, /npm install -g @rdk-moss\/agent@latest/);
assert.match(message, /brew install node@22/);
assert.match(message, /nvm install 22 && nvm use 22/);
assert.match(message, /fnm install 22 && fnm use 22/);
assert.match(message, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
assert.match(message, /sudo apt-get install -y nodejs/);
assert.match(message, /winget install OpenJS\.NodeJS\.LTS/);
assert.match(
  message,
  /NVM_NODEJS_ORG_MIRROR=https:\/\/npmmirror\.com\/mirrors\/node nvm install 22/
);

const zh = upgradeMessage('20.19.2', { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' });
assert.match(zh, /检测到 Node 20\.19\.2/);
assert.match(zh, /npm install -g @rdk-moss\/agent@latest/);
assert.match(zh, /brew install node@22/);
assert.match(zh, /winget install OpenJS\.NodeJS\.LTS/);

assert.equal(pkg.scripts.preinstall, 'node scripts/check-node-version.cjs');
assert.equal(pkg.scripts.prepare, 'node scripts/check-node-version.cjs && npm run build');
assert.equal(pkg.private, false);
assert.ok(pkg.files.includes('scripts/check-node-version.cjs'));

const ok = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
assert.equal(ok.status, 0, ok.stderr);
assert.equal(ok.stderr, '');

const fake = spawnSync(process.execPath, [script], {
  encoding: 'utf8',
  timeout: 10_000,
  env: {
    ...process.env,
    MOSS_TEST_FAKE_NODE_VERSION: '20.19.2',
    LC_ALL: 'C',
    LANG: 'en_US.UTF-8',
  },
});
assert.notEqual(fake.status, 0, fake.stderr);
assert.match(fake.stderr, /Node 20\.19\.2/);
assert.match(fake.stderr, /npm install -g @rdk-moss\/agent@latest/);
assert.match(fake.stderr, /winget install OpenJS\.NodeJS\.LTS/);
assert.match(fake.stderr, /brew install node@22/);

console.log('[PASS] node version preinstall');
