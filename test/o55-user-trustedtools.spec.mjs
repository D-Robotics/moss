#!/usr/bin/env node
/**
 * O55: a user's trustedTools array wins exactly over a TRUSTED project's list.
 * The project list applies only when the user did not set trustedTools.
 * An untrusted project's trustedTools stays dropped.
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
  const env = isolatedCliEnv({ prefix: 'moss-o55-' });
  for (const key of Object.keys(env)) {
    if (/^MOSS_(SAFETY|APPROVAL|ASK_FOR|TRUST|AUTO_APPROVE|CLI_|DEVICE)/.test(key)) {
      delete env[key];
    }
  }
  delete env.MOSS_TRUSTED_TOOLS;
  delete env.MOSS_PROFILE;
  delete env.MOSS_CONFIG_PROFILE;
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

check('user [read_file] wins over trusted project [read_file, exec]', () => {
  const { loaded, resolved } = setup(
    { trustedTools: ['read_file', 'exec'] },
    { trust: true, user: { trustedTools: ['read_file'] } }
  );
  assert.deepEqual(loaded.config.trustedTools, ['read_file']);
  assert.deepEqual(resolved.trustedTools, ['read_file']);
  assert.ok(!resolved.trustedTools.includes('exec'));
});

check('user unset + trusted project [exec] resolves to [exec]', () => {
  const { loaded, resolved } = setup({ trustedTools: ['exec'] }, { trust: true });
  assert.deepEqual(loaded.config.trustedTools, ['exec']);
  assert.deepEqual(resolved.trustedTools, ['exec']);
  assert.equal(loaded.droppedProjectPermissions, undefined);
});

check('untrusted project [exec] with user unset does not grant exec', () => {
  const { loaded, resolved } = setup({ trustedTools: ['exec'] });
  assert.deepEqual(loaded.droppedProjectPermissions, ['trustedTools']);
  assert.equal(loaded.config.trustedTools, undefined);
  assert.ok(!resolved.trustedTools.includes('exec'));
});

if (failures.length > 0) {
  console.log(`${failures.length} failing`);
  process.exit(1);
}
console.log('[PASS] o55-user-trustedtools');
