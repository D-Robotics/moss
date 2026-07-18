#!/usr/bin/env node
/**
 * Onboarding and help text — tested from the user's perspective:
 * does the user get useful guidance when they start Moss for the first time?
 */
import assert from 'node:assert/strict';

import { renderCliInteractiveHelp, renderCliStatus, renderProgressiveOnboardingTips } from '../dist/cli/onboarding.js';
import { formatCommunityAuthStatus } from '../dist/cli/community-auth.js';

// ─── renderCliStatus — live runtime config ──────────────────────────────────

{
  const agent = {
    config: { model: 'new-model' },
    tools: { getAll: () => [], size: 0 },
  };
  const status = renderCliStatus(agent, {
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
  }, { verbose: true });
  assert.ok(status.includes('new.example'), 'verbose status reads the live config base URL');
  assert.ok(!status.includes('old.example'), 'verbose status ignores the stale runtime base URL snapshot');
}

// ─── renderCliInteractiveHelp — the /help command output ─────────────────────

{
  const help = renderCliInteractiveHelp();
  assert.ok(typeof help === 'string' && help.length > 0, '/help output is non-empty');
  assert.ok(help.includes('/help'), '/help output mentions the /help command itself');
  assert.ok(help.includes('/clear'), '/help output includes /clear');
  assert.ok(help.includes('/model'), '/help output includes /model');
  assert.ok(help.includes('/sessions'), '/help output includes /sessions');
  assert.ok(help.includes('Ctrl+C'), '/help output mentions how to exit');
  assert.ok(help.includes('Ctrl+O') || help.includes('tool'), '/help mentions tool expansion shortcut');
  assert.ok(help.includes('Ctrl+V') || help.includes('attach'), '/help mentions file attachment');
}

{
  const compact = formatCommunityAuthStatus({
    authenticated: false,
    reason: 'missing',
    sessionPath: '/Users/test/.config/moss/community-auth.json',
  }, { includePath: false });
  assert.equal(compact, 'not logged in (optional); run moss auth login');
  assert.ok(!compact.includes('.json'), 'compact status omits a long filesystem path that wraps poorly in narrow terminals');
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
    'first-run shows welcome message',
  );
  // Lead with guided onboarding; model remains discoverable
  assert.ok(tips.includes('/quickstart'), 'first-run leads with /quickstart');
  assert.ok(tips.includes('/help'), 'first-run surfaces /help');
  assert.ok(tips.includes('/model') || tips.includes('model') || tips.includes('模型'), 'first-run guides user to pick a model');
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
      tips.includes('apiKey') || tips.includes('API key') || tips.includes('setup') || tips.includes('configure'),
      'missing API key state mentions how to configure a key',
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
      'missing model state mentions /model command',
    );
  }
}

console.log('[PASS] Onboarding and help text');
