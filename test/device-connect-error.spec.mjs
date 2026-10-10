#!/usr/bin/env node
/**
 * Device connect failures are one language, one class, one next step.
 * A configured board is probed first, and the prompt never asks for a password.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDeviceConnectError,
  formatDeviceConnectError,
  isFinalDeviceConnectError,
} from '../dist/device/device-connect-error.js';
import {
  CONFIGURED_DEVICE_PROMPT,
  DEVICE_CREDENTIAL_RULE,
} from '../dist/device/device-probe-prompt.js';
import { deviceInfoTool } from '../dist/tools/device-tools.js';
import { isUnreachableConnectError } from '../dist/device/device-registry.js';

const WHERE = '10.0.0.8:22';

function english(kind, extra = {}) {
  return formatDeviceConnectError({
    kind,
    where: WHERE,
    host: '10.0.0.8',
    timeoutMs: 10_000,
    locale: 'en_US.UTF-8',
    ...extra,
  });
}

function chinese(kind, extra = {}) {
  return formatDeviceConnectError({
    kind,
    where: WHERE,
    host: '10.0.0.8',
    timeoutMs: 10_000,
    locale: 'zh_CN.UTF-8',
    ...extra,
  });
}

test('connect errors are distinct and one language each', () => {
  const cases = [
    ['connect ECONNREFUSED 10.0.0.8:22', 'refused'],
    ['Timed out while waiting for handshake (10000ms)', 'timeout'],
    ['getaddrinfo ENOTFOUND board.local', 'dns'],
    ['All configured authentication methods failed', 'auth'],
    ['REMOTE HOST IDENTIFICATION HAS CHANGED', 'host_key'],
    ['No credentials for device board', 'credentials'],
  ];
  for (const [raw, kind] of cases) {
    assert.equal(classifyDeviceConnectError(raw), kind, raw);
  }

  const refused = english('refused');
  assert.match(refused.message, /Connection refused by 10\.0\.0\.8:22/);
  assert.doesNotMatch(refused.message, /within|无法/);
  assert.match(refused.hint, /sshd/);
  assert.doesNotMatch(`${refused.message}\n${refused.hint}`, /[\u4e00-\u9fff]/);

  const timeout = english('timeout');
  assert.match(timeout.message, /No route to 10\.0\.0\.8:22/);
  assert.match(timeout.message, /within 10s/);
  assert.doesNotMatch(timeout.message, /Connection refused|无法/);

  const dns = english('dns');
  assert.match(dns.message, /Could not resolve 10\.0\.0\.8/);
  assert.match(dns.hint, /MOSS_DEVICE_HOST/);

  const auth = english('auth');
  assert.match(auth.message, /Authentication failed for 10\.0\.0\.8:22/);
  assert.match(auth.hint, /moss device add/);
  assert.match(auth.hint, /MOSS_DEVICE_PASSWORD/);
  assert.match(auth.hint, /MOSS_DEVICE_KEY/);
  assert.doesNotMatch(auth.hint, /Paste (?:your|the) (?:board )?(?:password|key)/);

  const hostKey = english('host_key');
  assert.match(hostKey.message, /host key for 10\.0\.0\.8:22 changed/);
  assert.match(hostKey.hint, /known host/);
  assert.doesNotMatch(hostKey.hint, /Paste (?:your|the) (?:board )?(?:password|key)/);

  const missing = english('credentials');
  assert.match(missing.message, /No credentials are configured/);
  assert.match(missing.hint, /moss device add/);
  assert.doesNotMatch(missing.hint, /Paste (?:your|the) (?:board )?(?:password|key)/);

  const zhRefused = chinese('refused');
  assert.match(zhRefused.message, /拒绝了连接/);
  assert.doesNotMatch(`${zhRefused.message}\n${zhRefused.hint}`, /Connection refused|within/);
  const zhTimeout = chinese('timeout');
  assert.match(zhTimeout.message, /没有路由/);
  assert.doesNotMatch(zhTimeout.message, /No route|Connection refused/);
  const zhDns = chinese('dns');
  assert.match(zhDns.message, /无法解析/);
  assert.doesNotMatch(zhDns.message, /Could not resolve/);
});

test('refused, timeout, and DNS are final; auth is not cached as unreachable', () => {
  assert.equal(isFinalDeviceConnectError('connect ECONNREFUSED 10.0.0.8:22'), true);
  assert.equal(isFinalDeviceConnectError('No route to 10.0.0.8:22 (no answer within 10s).'), true);
  assert.equal(isFinalDeviceConnectError('到 10.0.0.8:22 没有路由（10 秒内没有应答）。'), true);
  assert.equal(isFinalDeviceConnectError('10.0.0.8:22 拒绝了连接。'), true);
  assert.equal(isFinalDeviceConnectError('无法解析 board.local。'), true);
  assert.equal(isFinalDeviceConnectError('Cannot reach 10.0.0.1:22 within 10s'), true);
  assert.equal(isUnreachableConnectError('ETIMEDOUT'), true);
  assert.equal(isFinalDeviceConnectError('Authentication failed for 10.0.0.8:22.'), false);
  assert.equal(isUnreachableConnectError('Authentication failed for 10.0.0.8:22.'), false);
  assert.equal(isFinalDeviceConnectError('The host key for 10.0.0.8:22 changed.'), false);
  assert.equal(isFinalDeviceConnectError('No credentials are configured for 10.0.0.8:22.'), false);
});

test('a configured device is probed first and passwords stay out of chat', () => {
  assert.match(CONFIGURED_DEVICE_PROMPT, /first action is `device_info`/);
  assert.match(CONFIGURED_DEVICE_PROMPT, /Do not read config/);
  assert.match(DEVICE_CREDENTIAL_RULE, /moss device add/);
  assert.match(DEVICE_CREDENTIAL_RULE, /MOSS_DEVICE_PASSWORD/);
  assert.match(DEVICE_CREDENTIAL_RULE, /MOSS_DEVICE_KEY/);
  assert.match(DEVICE_CREDENTIAL_RULE, /ssh key/);
  assert.match(DEVICE_CREDENTIAL_RULE, /Never ask the user to paste/);
  assert.doesNotMatch(CONFIGURED_DEVICE_PROMPT, /Paste (?:your|the) (?:board )?(?:password|key)/);
  assert.match(deviceInfoTool.description, /call this first when the user asks about the board/);
  assert.match(deviceInfoTool.description, /MOSS_DEVICE_HOST/);
  assert.match(deviceInfoTool.description, /RDK board or Linux host/);
  assert.ok(deviceInfoTool.description.includes(DEVICE_CREDENTIAL_RULE));
  assert.doesNotMatch(deviceInfoTool.description, /Paste (?:your|the) (?:board )?(?:password|key)/);
});
