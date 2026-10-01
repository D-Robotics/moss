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
  renderProgressiveOnboardingTips,
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
  assert.ok(verbose.includes('Profiles:'), 'verbose permissions keeps the detailed reference');
  assert.ok(verbose.includes('/permissions'), 'verbose permissions keeps command guidance');
  assert.ok(
    verbose.split('\n').length <= 50,
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

// ─── renderProgressiveOnboardingTips — context-aware first-run tips ──────────

{
  // First run: user has nothing configured
  const tips = renderProgressiveOnboardingTips({
    isFirstRun: true,
    hasApiKey: false,
    hasMissingApiKey: false,
    hasMissingModel: false,
    hasDeviceConnected: false,
    hasAgentsMdInWorkspace: false,
    hasPreviousSessions: false,
  });
  assert.ok(typeof tips === 'string' && tips.length > 0, 'first-run tips are non-empty');
  assert.ok(
    tips.includes('Welcome') || tips.includes('欢迎') || tips.includes('get you set up'),
    'first-run shows welcome message'
  );
  // Lead with guided onboarding; model remains discoverable
  assert.ok(tips.includes('/quickstart'), 'first-run leads with /quickstart');
  assert.ok(tips.includes('/help'), 'first-run surfaces /help');
  assert.ok(
    tips.includes('/model') || tips.includes('model') || tips.includes('模型'),
    'first-run guides user to pick a model'
  );
  assert.ok(tips.split('\n').length <= 3, 'first-run guidance stays compact in the TUI');
}

{
  // Chinese locale: first-run tips should not force English
  const prev = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
  try {
    const tips = renderProgressiveOnboardingTips({
      isFirstRun: true,
      hasApiKey: false,
      hasMissingApiKey: false,
      hasMissingModel: false,
      hasDeviceConnected: false,
      hasAgentsMdInWorkspace: false,
      hasPreviousSessions: false,
    });
    assert.ok(tips.includes('欢迎'), 'zh first-run welcome is Chinese');
    assert.ok(tips.includes('/quickstart'), 'zh first-run still leads with /quickstart');
    assert.ok(!tips.includes('Welcome to Moss'), 'zh first-run does not keep English welcome');
  } finally {
    if (prev.LANG === undefined) delete process.env.LANG;
    else process.env.LANG = prev.LANG;
    if (prev.LC_ALL === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prev.LC_ALL;
    if (prev.LC_MESSAGES === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = prev.LC_MESSAGES;
  }
}

{
  // Missing API key for a cloud provider is a critical gap — user needs to see this
  const tips = renderProgressiveOnboardingTips({
    isFirstRun: false,
    hasApiKey: false,
    hasMissingApiKey: true,
    hasMissingModel: false,
    hasDeviceConnected: false,
    hasAgentsMdInWorkspace: false,
    hasPreviousSessions: false,
  });
  assert.ok(typeof tips === 'string', 'renders without crashing when API key is missing');
  // Should mention the missing API key problem
  if (tips.length > 0) {
    assert.ok(
      tips.includes('apiKey') ||
        tips.includes('API key') ||
        tips.includes('setup') ||
        tips.includes('configure'),
      'missing API key state mentions how to configure a key'
    );
  }
}

{
  // Returning user with everything configured
  const tips = renderProgressiveOnboardingTips({
    isFirstRun: false,
    hasApiKey: true,
    hasMissingApiKey: false,
    hasMissingModel: false,
    hasDeviceConnected: true,
    hasAgentsMdInWorkspace: true,
    hasPreviousSessions: true,
  });
  // May be empty (nothing to tip about) or show advanced usage tips
  assert.ok(typeof tips === 'string', 'renders without crashing for returning user');
}

{
  // Missing model for openai-compatible setup
  const tips = renderProgressiveOnboardingTips({
    isFirstRun: false,
    hasApiKey: true,
    hasMissingApiKey: false,
    hasMissingModel: true,
    hasDeviceConnected: false,
    hasAgentsMdInWorkspace: false,
    hasPreviousSessions: false,
  });
  assert.ok(typeof tips === 'string', 'renders without crashing when model is missing');
  if (tips.length > 0) {
    assert.ok(
      tips.includes('/model') || tips.includes('model'),
      'missing model state mentions /model command'
    );
  }
}

console.log('[PASS] Onboarding and help text');
