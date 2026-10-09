#!/usr/bin/env node
/** `moss setup` menu copy follows the locale. */
import assert from 'node:assert/strict';

import { setupMenuLines } from '../dist/cli/setup-wizard.js';

const en = setupMenuLines('en_US.UTF-8').join('\n');
assert.match(en, /Moss model setup/);
assert.match(en, /Choose provider:/);
assert.equal(en.includes('选择提供方'), false);

const zh = setupMenuLines('zh_CN.UTF-8').join('\n');
assert.match(zh, /模型配置/);
assert.match(zh, /选择提供方/);
assert.equal(zh.includes('Choose provider'), false);

console.log('[PASS] setup-wizard');
