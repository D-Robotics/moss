#!/usr/bin/env node
/**
 * O56: an untrusted project .moss/config.json must not grant
 * permissions.deviceTrust or permissions.trustedDevices. A trusted project
 * still cannot set deviceTrust full over an unset or gated user, and cannot
 * add trustedDevices the user did not list.
 * O54 stays here as anti-regression: untrusted approvalPolicy / safetyMode
 * must not loosen the resolved mode.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';
import { loadCliConfigFile, resolveCliConfig } from '../dist/cli/config.js';

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function setup(project, { trust = false, user = {} } = {}) {
  const env = isolatedCliEnv({ prefix: 'moss-o56-' });
  for (const key of Object.keys(env)) {
    if (/^MOSS_(SAFETY|APPROVAL|ASK_FOR|TRUST|AUTO_APPROVE|CLI_|DEVICE)/.test(key)) {
      delete env[key];
    }
  }
  const ws = path.join(env.HOME, 'ws');
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), user);
  put(path.join(ws, '.moss', 'config.json'), project);
  const loaded = loadCliConfigFile(env, [], ws, { trustProjectRouting: trust });
  const resolved = resolveCliConfig(env, loaded.config, {}, loaded);
  return { loaded, resolved };
}

const failures = [];
function check(label, fn) {
  try {
    fn();
    console.log(`[PASS] ${label}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(label);
    console.log(`[FAIL] ${label}: ${message}`);
  }
}

check('O54 approvalPolicy=never from untrusted project is ignored', () => {
  const { resolved } = setup({ approvalPolicy: 'never' });
  assert.notEqual(
    resolved.approvalPolicySource,
    'project',
    `approvalPolicy=${resolved.approvalPolicy} source=${resolved.approvalPolicySource}`
  );
});

check('O54 safetyMode=full-access from untrusted project is ignored', () => {
  const { resolved } = setup({ safetyMode: 'full-access' });
  assert.notEqual(
    resolved.safetyMode,
    'full-access',
    `safetyMode=${resolved.safetyMode} source=${resolved.safetyModeSource}`
  );
});

check('O56 permissions.deviceTrust=full from untrusted project is ignored', () => {
  const { loaded, resolved } = setup({ permissions: { deviceTrust: 'full' } });
  assert.equal(resolved.permissions.deviceTrust, 'gated');
  assert.notEqual(loaded.config.permissions?.deviceTrust, 'full');
  assert.deepEqual(loaded.droppedProjectPermissions, ['permissions.deviceTrust']);
});

check('O56 permissions.trustedDevices from untrusted project is ignored', () => {
  const { loaded, resolved } = setup({ permissions: { trustedDevices: ['rdk-x5'] } });
  assert.deepEqual(resolved.permissions.trustedDevices, []);
  assert.deepEqual(loaded.config.permissions?.trustedDevices ?? [], []);
  assert.deepEqual(loaded.droppedProjectPermissions, ['permissions.trustedDevices']);
});

check('O56 untrusted project device trust is recorded and user full still stands', () => {
  const { loaded, resolved } = setup(
    { permissions: { deviceTrust: 'full', trustedDevices: ['rdk-x5'] } },
    { user: { permissions: { deviceTrust: 'full', trustedDevices: ['board-a'] } } }
  );
  assert.equal(resolved.permissions.deviceTrust, 'full');
  assert.deepEqual(resolved.permissions.trustedDevices, ['board-a']);
  assert.deepEqual(loaded.droppedProjectPermissions, [
    'permissions.deviceTrust',
    'permissions.trustedDevices',
  ]);
});

check('trusted folder: user unset + project deviceTrust full is not full', () => {
  const { loaded, resolved } = setup(
    { permissions: { deviceTrust: 'full', trustedDevices: ['rdk-x5'] } },
    { trust: true }
  );
  assert.equal(resolved.permissions.deviceTrust, 'gated');
  assert.notEqual(loaded.config.permissions?.deviceTrust, 'full');
  assert.deepEqual(resolved.permissions.trustedDevices, []);
  assert.equal(loaded.droppedProjectPermissions, undefined);
});

check('trusted folder: user gated + project deviceTrust full is not full', () => {
  const { resolved } = setup(
    { permissions: { deviceTrust: 'full', trustedDevices: ['rdk-x5'] } },
    { trust: true, user: { permissions: { deviceTrust: 'gated', trustedDevices: ['board-a'] } } }
  );
  assert.equal(resolved.permissions.deviceTrust, 'gated');
  assert.deepEqual(resolved.permissions.trustedDevices, []);
  assert.ok(!resolved.permissions.trustedDevices.includes('rdk-x5'));
});

check('trusted folder: project trustedDevices outside the user list are not trusted', () => {
  const { loaded, resolved } = setup(
    { permissions: { trustedDevices: ['rdk-x5', 'evil'] } },
    { trust: true, user: { permissions: { trustedDevices: ['board-a', 'rdk-x5'] } } }
  );
  assert.deepEqual(resolved.permissions.trustedDevices, ['rdk-x5']);
  assert.deepEqual(loaded.config.permissions.trustedDevices, ['rdk-x5']);
  assert.ok(!resolved.permissions.trustedDevices.includes('evil'));
});

check('trusted folder: project deviceTrust gated tightens user full', () => {
  const { resolved } = setup(
    { permissions: { deviceTrust: 'gated' } },
    { trust: true, user: { permissions: { deviceTrust: 'full' } } }
  );
  assert.equal(resolved.permissions.deviceTrust, 'gated');
});

check('allowlist unions deny/ask, drops unknown project fields, and does not widen allow', () => {
  const untrusted = setup(
    {
      permissions: {
        allow: ['exec'],
        ask: ['write_file'],
        deny: ['exec'],
        defaultMode: 'full',
        notAPermission: ['device_exec'],
      },
    },
    { user: { permissions: { defaultMode: 'manual', deny: ['read_file'], allow: ['read_file'] } } }
  );
  assert.equal(untrusted.resolved.permissions.defaultMode, 'manual');
  assert.deepEqual(untrusted.resolved.permissions.allow, ['read_file']);
  assert.deepEqual(untrusted.resolved.permissions.ask, ['write_file']);
  assert.deepEqual(untrusted.resolved.permissions.deny, ['read_file', 'exec']);
  assert.equal('notAPermission' in (untrusted.loaded.config.permissions ?? {}), false);
  assert.ok(untrusted.loaded.droppedProjectPermissions.includes('permissions.allow'));
  assert.ok(untrusted.loaded.droppedProjectPermissions.includes('permissions.defaultMode'));

  const trusted = setup(
    { permissions: { allow: ['exec'], defaultMode: 'full', notAPermission: ['device_exec'] } },
    { trust: true, user: { permissions: { defaultMode: 'manual', allow: ['read_file'] } } }
  );
  assert.equal(trusted.resolved.permissions.defaultMode, 'manual');
  assert.deepEqual(trusted.resolved.permissions.allow, ['read_file', 'exec']);
  assert.equal('notAPermission' in (trusted.loaded.config.permissions ?? {}), false);
});

if (failures.length > 0) {
  console.log(`${failures.length} failing`);
  process.exit(1);
}
console.log('[PASS] o56-untrusted-permissions');
