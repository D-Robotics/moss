#!/usr/bin/env node
/**
 * Onboarding and help text — tested from the user's perspective:
 * does the user get useful guidance when they start Moss for the first time?
 */
import assert from 'node:assert/strict';

import {
  renderCliInteractiveHelp,
  renderCliPermissions,
  renderCliStatus,
} from '../dist/cli/onboarding.js';

// ─── renderCliPermissions — concise by default, detailed on demand ───────────

{
  const runtime = {
    workspace: '/tmp/project',
    config: {
      configPath: '/tmp/config.json',
      workspace: '/tmp/project',
      workspaceSource: 'cwd',
      profile: 'balanced',
      safetyMode: 'workspace-write',
      approvalPolicy: 'prompt',
      trustedTools: [],
      deniedTools: [],
      maxAgentTurns: 64,
      contextTokens: 128000,
    },
  };
  const concise = renderCliPermissions(runtime);
  assert.ok(concise.includes('Permissions'), 'default permissions output has a clear title');
  assert.ok(
    !concise.includes('Profiles:'),
    'default permissions output omits the reference manual'
  );
  assert.ok(concise.includes('/permissions --verbose'), 'default output points to diagnostics');
  const verbose = renderCliPermissions(runtime, { verbose: true });
  // v0.26 (T04): the help leads with the single mode axis (four states) and
  // the rule manager syntax.
  assert.ok(verbose.includes('One mode axis'), 'verbose permissions leads with the mode axis');
  assert.ok(verbose.includes('/mode plan'), 'verbose permissions shows the modes');
  assert.ok(verbose.includes('/mode full'), 'verbose permissions shows the full mode (v0.26)');
  assert.ok(
    verbose.includes('/permissions add deny'),
    'verbose permissions shows the rule-manager syntax'
  );
  assert.ok(verbose.includes('/permissions'), 'verbose permissions keeps command guidance');
  assert.ok(
    !verbose.includes('Profiles:'),
    'the profile concept retires from the permissions help'
  );
  assert.ok(
    verbose.split('\n').length <= 60,
    `verbose permissions stays compact (got ${verbose.split('\n').length} lines)`
  );
  assert.ok(
    verbose.includes('moss config --help'),
    'verbose permissions points at the config reference instead of restating it'
  );
}

// ─── one snapshot source: verbose status & verbose permissions agree ────────

{
  const agent = { config: { model: 'new-model' }, tools: { getAll: () => [], size: 0 } };
  const runtime = {
    workspace: '/tmp/project',
    config: {
      configPath: '/tmp/config.json',
      projectConfigPath: '',
      workspace: '/tmp/project',
      workspaceSource: 'cwd',
      provider: 'deepseek',
      providerSource: 'config',
      model: 'new-model',
      modelSource: 'config',
      baseUrl: 'https://new.example/v1',
      baseUrlSource: 'config',
      apiKey: 'test-key',
      apiKeySource: 'config',
      apiKeyEncrypted: true,
      usingBundledDefault: false,
      profile: 'balanced',
      profileSource: 'config',
      safetyMode: 'workspace-write',
      safetyModeSource: 'config',
      approvalPolicy: 'prompt',
      approvalPolicySource: 'config',
      trustedTools: ['exec'],
      trustedToolsSource: 'config',
      deniedTools: [],
      deniedToolsSource: 'default',
      promptCacheEnabled: true,
      promptCacheSource: 'config',
      promptCacheDebug: false,
      promptCacheDebugSource: 'default',
      guardrails: {
        input: { blockPatterns: [], redactPatterns: [] },
        output: { blockPatterns: [], redactPatterns: [] },
      },
      guardrailsSource: 'default',
      maxAgentTurns: 64,
      maxAgentTurnsSource: 'default',
      contextTokens: 128000,
      contextTokensSource: 'config',
      compactionSettings: { reserveTokens: 20000, keepRecentTokens: 20000 },
      compactionSettingsSource: 'default',
      ignoredModelEnvVars: [],
    },
  };
  const status = renderCliStatus(agent, runtime, { verbose: true });
  const perms = renderCliPermissions(runtime, { verbose: true });
  for (const shared of [
    'workspace-write (config)',
    'exec (config)',
    'reserve 20000, keepRecent 20000 (default)',
    'prompt (config)',
  ]) {
    assert.ok(status.includes(shared), `verbose status includes ${shared}`);
    assert.ok(perms.includes(shared), `verbose permissions includes ${shared}`);
  }
}

// ─── renderCliStatus — live runtime config ──────────────────────────────────

{
  const agent = {
    config: { model: 'new-model' },
    tools: { getAll: () => [], size: 0 },
  };
  const status = renderCliStatus(
    agent,
    {
      baseUrl: 'https://old.example/v1',
      config: {
        provider: 'openai-compatible',
        providerSource: 'config',
        model: 'new-model',
        modelSource: 'config',
        baseUrl: 'https://new.example/v1',
        baseUrlSource: 'config',
        apiKey: 'test-key',
        apiKeySource: 'config',
        usingBundledDefault: false,
        approvalPolicy: 'never',
        maxAgentTurns: 20,
        contextTokens: 128000,
      },
    },
    { verbose: true }
  );
  assert.ok(status.includes('new.example'), 'verbose status reads the live config base URL');
  assert.ok(
    !status.includes('old.example'),
    'verbose status ignores the stale runtime base URL snapshot'
  );
}

// ─── renderCliInteractiveHelp — the /help command output ─────────────────────

{
  const help = renderCliInteractiveHelp();
  assert.ok(typeof help === 'string' && help.length > 0, '/help output is non-empty');
  assert.ok(help.includes('/help'), '/help output mentions the /help command itself');
  assert.ok(help.includes('/compact'), '/help output includes /compact');
  assert.ok(help.includes('/model'), '/help output includes /model');
  assert.ok(help.includes('/sessions'), '/help output includes /sessions');
  assert.ok(help.includes('Ctrl+C'), '/help output mentions how to exit');
}

console.log('[PASS] Onboarding and help text');
