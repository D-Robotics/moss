#!/usr/bin/env node
/** Node floor stays 22.16. The bin and the ESM check share one message, including Chinese. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeVersionProblem } from '../dist/cli/node-version-check.js';

const require = createRequire(import.meta.url);
const fromBin = require('../bin/node-version-message.cjs').nodeVersionProblem;

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mirror = 'NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22';
const en = { LC_ALL: 'C', LANG: 'en_US.UTF-8' };

assert.equal(nodeVersionProblem('v22.16.0', en), null);
assert.equal(nodeVersionProblem('v24.0.0', en), null);
const old = nodeVersionProblem('v20.19.2', en);
assert.ok(old);
assert.equal(old, fromBin('v20.19.2', en));
assert.match(old, /22\.16/);
assert.match(old, /nvm install 22/);
assert.match(old, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
assert.match(old, new RegExp(mirror.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.doesNotMatch(old, /--mirror/);

const zh = nodeVersionProblem('v20.19.2', { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' });
assert.equal(zh, fromBin('v20.19.2', { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }));
assert.match(zh, /版本过低/);
assert.match(zh, /nvm install 22/);
assert.match(nodeVersionProblem('v20.19.2', { LC_ALL: 'zh_CN.UTF-8' }), /版本过低/);

const bin = fs.readFileSync(path.join(repoRoot, 'bin', 'moss.cjs'), 'utf8');
assert.match(bin, /node-version-message\.cjs/);
assert.doesNotMatch(bin, /Moss needs Node/);
assert.doesNotMatch(bin, /版本过低/);
assert.match(bin, /import\('\.\.\/dist\/cli\.js'\)/);
const message = fs.readFileSync(path.join(repoRoot, 'bin', 'node-version-message.cjs'), 'utf8');
assert.match(message, /nvm install 22/);
assert.match(message, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
assert.match(
  message,
  /NVM_NODEJS_ORG_MIRROR=https:\/\/npmmirror\.com\/mirrors\/node nvm install 22/
);
assert.match(message, /版本过低/);
assert.doesNotMatch(message, /--mirror/);

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
assert.equal(pkg.engines.node, '>=22.16.0');
assert.equal(pkg.bin.moss, 'bin/moss.cjs');

console.log('[PASS] node version check');
