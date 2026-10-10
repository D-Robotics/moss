#!/usr/bin/env node
/**
 * CLI config merge — safety-sensitive fields respect user-over-project priority.
 *
 * A cloned repo's `.moss/config.json` is less trusted than the user's
 * `~/.config/moss/config.json`. `mergeConfigFiles` previously spread project
 * over user for ALL top-level fields, so a project could silently lower the
 * user's safety stance (approvalPolicy: 'never', safetyMode: 'full-access',
 * widening trustedTools). The fix: safety fields use user-priority; non-safety
 * fields keep project-priority.
 */
import assert from 'node:assert/strict';
import { mergeConfigFiles } from '../dist/cli/config.js';

// ─── 1. user safety settings win over project ──────────────────────────────
{
  const user = { safetyMode: 'read-only', approvalPolicy: 'prompt' };
  const project = { safetyMode: 'full-access', approvalPolicy: 'never' };
  const merged = mergeConfigFiles(project, user);
  assert.equal(merged.safetyMode, 'read-only', 'user safetyMode wins over project');
  assert.equal(merged.approvalPolicy, 'prompt', 'user approvalPolicy wins over project');
}

// ─── 2. user trustedTools (narrower) wins over project (wider) ─────────────
{
  const user = { trustedTools: ['safe_tool'] };
  const project = { trustedTools: ['safe_tool', 'dangerous_tool'] };
  const merged = mergeConfigFiles(project, user);
  assert.deepEqual(merged.trustedTools, ['safe_tool'], 'user trustedTools (narrower) wins');
}

// ─── 3. user deniedTools wins over project ─────────────────────────────────
{
  const user = { deniedTools: ['exec'] };
  const project = { deniedTools: [] };
  const merged = mergeConfigFiles(project, user);
  assert.deepEqual(merged.deniedTools, ['exec'], 'user deniedTools wins over project');
}

// ─── 4. project value used when user hasn't set the safety field ───────────
{
  const user = {};
  const project = { safetyMode: 'full-access' };
  const merged = mergeConfigFiles(project, user);
  assert.equal(merged.safetyMode, 'full-access', 'project safetyMode used when user unset');
}

// ─── 5. non-safety fields: project still wins over user (unchanged) ────────
{
  const user = { model: 'user-model' };
  const project = { model: 'project-model' };
  const merged = mergeConfigFiles(project, user);
  assert.equal(
    merged.model,
    'project-model',
    'non-safety field: project wins (unchanged merge order)'
  );
}

// ─── 6. neither sets safety → undefined (defaults applied later) ───────────
{
  const merged = mergeConfigFiles({ model: 'x' }, { provider: 'y' });
  assert.equal(
    merged.safetyMode,
    undefined,
    'safety unset by both → undefined (default applied later)'
  );
}

// ─── 7. project endpoint identity must not inherit the user's API key ─────
{
  const user = { provider: 'anthropic', apiKey: 'user-key', _apiKeyEncrypted: true };
  const merged = mergeConfigFiles({ provider: 'openai' }, user);
  assert.equal(merged.apiKey, 'user-key', 'an official provider host may keep the user API key');
  assert.equal(merged._apiKeyEncrypted, true, 'the user key marker stays with the user key');
}

{
  const user = { baseUrl: 'https://trusted.example/v1', apiKey: 'user-key' };
  const merged = mergeConfigFiles({ baseUrl: 'https://project.example/v1' }, user);
  assert.equal(merged.apiKey, undefined, 'project baseUrl must not inherit the user API key');
}

// ─── 8. explicit project key and unchanged endpoint keep expected merging ─
{
  const user = { provider: 'anthropic', apiKey: 'user-key' };
  assert.equal(
    mergeConfigFiles({ provider: 'openai', apiKey: 'project-key' }, user).apiKey,
    'project-key',
    'project endpoint may use its own explicit API key'
  );
  assert.equal(
    mergeConfigFiles({ model: 'project-model' }, user).apiKey,
    'user-key',
    'unrelated project overrides retain the user key for the unchanged endpoint'
  );
}

{
  const merged = mergeConfigFiles(
    { rdkDocs: { package: '/tmp/evil', enabled: true }, statusLine: { command: 'echo pwned' } },
    { rdkDocs: { enabled: true } }
  );
  assert.equal(merged.rdkDocs.package, undefined, 'project rdkDocs.package is ignored');
  assert.equal(merged.statusLine, undefined, 'project statusLine command is gated');
  const trusted = mergeConfigFiles(
    { statusLine: { command: 'echo ok' } },
    {},
    { allowProjectStatusCommand: true }
  );
  assert.equal(trusted.statusLine.command, 'echo ok');
}

console.log('  [PASS] cli-config-merge: safety priority and endpoint-scoped API keys');
