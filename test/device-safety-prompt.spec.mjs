#!/usr/bin/env node
/** Chinese device-approval copy includes the refusal reason. */
import assert from 'node:assert/strict';

import { deviceDestructivePrompt } from '../dist/cli/device-safety-prompt.js';

const prompt = deviceDestructivePrompt({
  toolName: 'device_exec',
  tier: 'destructive',
  operand: 'reboot',
  reason: 'reboots the board',
  locale: 'zh_CN.UTF-8',
});

assert.match(prompt.headlessReason, /reboots the board/);
assert.match(prompt.headlessReason, /因此已拒绝/);
assert.equal(prompt.headlessReason.includes(':'), false);

console.log('[PASS] device-safety-prompt');
