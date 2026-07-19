#!/usr/bin/env node
/**
 * Locale helper + brief moss --help surface for Chinese first-timers.
 */
import assert from 'node:assert/strict';

import { briefHelpLines } from '../dist/cli/help.js';
import { isZhLocale } from '../dist/cli/cli-locale.js';

const identity = (s) => s;
const colors = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  cyan: identity,
  magenta: identity,
  gray: identity,
};

{
  assert.equal(isZhLocale('zh_CN.UTF-8'), true);
  assert.equal(isZhLocale('zh-Hans'), true);
  assert.equal(isZhLocale('en_US.UTF-8'), false);
  assert.equal(isZhLocale(undefined), false);
}

{
  const zh = briefHelpLines(colors, '/tmp/moss-config.json', true).join('\n');
  assert.ok(zh.includes('最常用'), 'zh brief help uses Chinese section title');
  assert.ok(zh.includes('/quickstart'), 'zh brief help surfaces /quickstart');
  assert.ok(zh.includes('进入 Moss 后'), 'zh brief help localizes Inside Moss');
  assert.ok(!zh.includes('Most useful'), 'zh brief help does not keep English section title');
}

{
  const en = briefHelpLines(colors, '/tmp/moss-config.json', false).join('\n');
  assert.ok(en.includes('Most useful'), 'en brief help keeps English section title');
  assert.ok(en.includes('/quickstart'), 'en brief help surfaces /quickstart');
  assert.ok(en.includes('Inside Moss'), 'en brief help keeps Inside Moss');
}

console.log('[PASS] cli locale + brief help');
