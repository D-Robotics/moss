#!/usr/bin/env node
/**
 * The env-var rename bridge: MOSS_* is the new public prefix, legacy DMOSS_*
 * still works. normalizeMossEnvAliases mirrors both directions in place so the
 * ~250 existing process.env.DMOSS_* reads keep working while users set MOSS_*.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { normalizeMossEnvAliases } from '../dist/cli/env-aliases.js';

// 1. New name wins and is mirrored onto its DMOSS_ twin (so existing reads see it).
{
  const env = { MOSS_DEVICE_HOST: '203.0.113.10' };
  const legacy = normalizeMossEnvAliases(env);
  assert.equal(env.DMOSS_DEVICE_HOST, '203.0.113.10', 'MOSS_X must mirror onto DMOSS_X');
  assert.deepEqual(legacy, [], 'using only MOSS_ is not legacy usage');
}

// 2. Legacy name still works and is reported so the caller can nudge migration.
{
  const env = { DMOSS_SAFETY_MODE: 'read-only' };
  const legacy = normalizeMossEnvAliases(env);
  assert.equal(env.MOSS_SAFETY_MODE, 'read-only', 'DMOSS_X must forward-fill MOSS_X');
  assert.deepEqual(legacy, ['DMOSS_SAFETY_MODE'], 'legacy var is reported');
}

// 3. When both are set, MOSS_ wins and it is NOT counted as legacy.
{
  const env = { MOSS_PROFILE: 'autonomous', DMOSS_PROFILE: 'cautious' };
  const legacy = normalizeMossEnvAliases(env);
  assert.equal(env.DMOSS_PROFILE, 'autonomous', 'MOSS_ overrides DMOSS_ when both present');
  assert.equal(env.MOSS_PROFILE, 'autonomous');
  assert.deepEqual(legacy, [], 'not legacy when the new name is present');
}

// 4. Unrelated env vars are never touched.
{
  const env = { PATH: '/usr/bin', HOME: '/home/x' };
  normalizeMossEnvAliases(env);
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/x' });
}

console.log('[PASS] env-aliases: MOSS_ <-> DMOSS_ bridge, new-name-wins, legacy reporting');
