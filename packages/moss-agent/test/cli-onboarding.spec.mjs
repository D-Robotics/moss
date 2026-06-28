#!/usr/bin/env node
/**
 * Onboarding and help text — tested from the user's perspective:
 * does the user get useful guidance when they start Moss for the first time?
 */
import assert from 'node:assert/strict';

import { renderCliInteractiveHelp, renderProgressiveOnboardingTips } from '../dist/cli/onboarding.js';

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
  assert.ok(tips.includes('Welcome') || tips.includes('get you set up'), 'first-run shows welcome message');
  // Should guide user to pick a model
  assert.ok(tips.includes('/model') || tips.includes('model'), 'first-run guides user to pick a model');
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
