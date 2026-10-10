#!/usr/bin/env node
/** Node floor stays 22.16. The install text uses a valid nvm mirror env, not `--mirror`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeVersionProblem } from '../dist/cli/node-version-check.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mirror = 'NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22';

assert.equal(nodeVersionProblem('v22.16.0'), null);
assert.equal(nodeVersionProblem('v24.0.0'), null);
const old = nodeVersionProblem('v20.19.2');
assert.ok(old);
assert.match(old, /22\.16/);
assert.match(old, /nvm install 22/);
assert.match(old, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
assert.match(old, new RegExp(mirror.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.doesNotMatch(old, /--mirror/);

const bin = fs.readFileSync(path.join(repoRoot, 'bin', 'moss.cjs'), 'utf8');
assert.match(bin, /nvm install 22/);
assert.match(bin, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
assert.match(bin, /NVM_NODEJS_ORG_MIRROR=https:\/\/npmmirror\.com\/mirrors\/node nvm install 22/);
assert.doesNotMatch(bin, /--mirror/);
assert.match(bin, /import\('\.\.\/dist\/cli\.js'\)/);

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
assert.equal(pkg.engines.node, '>=22.16.0');
assert.equal(pkg.bin.moss, 'bin/moss.cjs');

console.log('[PASS] node version check');
