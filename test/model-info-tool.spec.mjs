#!/usr/bin/env node
/**
 * Regression test: `current_model` must reflect the live model after an
 * in-session config switch, not the frozen startup snapshot.
 *
 * Reproduces the bug where `config`/`provider` were captured by value at
 * startup, so after `/model config ...` switched the model, `current_model`
 * kept reporting the old model name.
 */
import assert from 'node:assert/strict';

import { createModelInfoTool } from '../dist/cli/model-info-tool.js';
import { reportedModelMatchesConfigured } from '../dist/cli/model-resolution.js';

// ─── Live config holder (simulates agent.config + providerConfig) ──────────────
// The tool receives getters, so it reads whatever these hold *at call time*.
let liveModel = 'deepseek-v4-flash';
let liveProvider = { complete: async () => ({ model: 'deepseek-v4-flash' }) };

const tool = createModelInfoTool({
  provider: () => liveProvider,
  config: () => ({
    model: liveModel,
    baseUrl: 'https://example.com',
    usingBundledDefault: false,
  }),
  getContextTokens: () => 128000,
  getMaxOutputTokens: () => 8192,
});

// ─── Before switch: reports the startup model ─────────────────────────────────
{
  const result = await tool.execute({ input: {} });
  assert.ok(
    result.includes('deepseek-v4-flash'),
    `before switch, current_model should report deepseek-v4-flash, got: ${result}`
  );
}

// ─── Simulate in-session /model config switch ─────────────────────────────────
liveModel = 'HORIZON-GLM';
liveProvider = { complete: async () => ({ model: 'HORIZON-GLM' }) };

// ─── After switch: must report the NEW model ──────────────────────────────────
{
  const result = await tool.execute({ input: {} });
  assert.ok(
    result.includes('HORIZON-GLM'),
    `after switch, current_model should report HORIZON-GLM, got: ${result}`
  );
  assert.ok(
    !result.includes('deepseek-v4-flash'),
    `after switch, current_model must NOT report the old model, got: ${result}`
  );
}

// ─── Gateway-reported id that differs from the configured model ───────────────
{
  const differed = createModelInfoTool({
    provider: () => ({ complete: async () => ({ model: 'configured-only' }) }),
    config: () => ({
      model: 'configured-only',
      baseUrl: 'https://example.com',
      usingBundledDefault: false,
    }),
    getReportedModel: () => 'gateway-served-id',
  });
  const result = await differed.execute({ input: {} });
  assert.match(
    result,
    /configured configured-only, gateway reported gateway-served-id/,
    `differing gateway model should be named, got: ${result}`
  );
  assert.ok(
    !result.endsWith('configured-only.'),
    `must not collapse to the configured id alone, got: ${result}`
  );
}

// ─── Date/version suffix and vendor prefix are the same model ────────────────
for (const [configured, reported] of [
  ['gpt-4o', 'gpt-4o-2024-08-06'],
  ['kimi-k2.8-preview', 'moonshotai/kimi-k2.8-preview-20260901'],
  ['gpt-4o', 'openai/gpt-4o'],
  ['gpt-4', 'gpt-4-0613'],
  ['glm-5.3', 'glm-5.3@2026-09-01'],
  ['glm-5.3', 'zhipu/glm-5.3-latest'],
  ['gpt-4', 'openai/gpt-4-0613@2026-09-01'],
]) {
  const aliased = createModelInfoTool({
    provider: () => ({ complete: async () => ({ model: configured }) }),
    config: () => ({
      model: configured,
      baseUrl: 'https://example.com',
      usingBundledDefault: false,
    }),
    getReportedModel: () => reported,
  });
  const result = await aliased.execute({ input: {} });
  assert.doesNotMatch(
    result,
    /gateway reported/,
    `${configured} vs ${reported} should not be a mismatch, got: ${result}`
  );
  assert.match(result, new RegExp(configured.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

// ─── Matcher unit: alias suffixes match, real renames do not ────────────────
{
  const same = [
    ['gpt-4o', 'gpt-4o-2024-08-06'],
    ['kimi-k2.8-preview', 'moonshotai/kimi-k2.8-preview-20260901'],
    ['gpt-4o', 'openai/gpt-4o'],
    ['gpt-4', 'gpt-4-0613'],
    ['glm-5.3', 'glm-5.3@2026-09-01'],
    ['glm-5.3', 'zhipu/glm-5.3-latest'],
    ['glm-5.3', 'zhipu/glm-5.3@latest'],
    ['gpt-4', 'openai/gpt-4-0613@2026-09-01'],
  ];
  for (const [configured, reported] of same) {
    assert.ok(
      reportedModelMatchesConfigured(configured, reported),
      `${configured} vs ${reported} should match`
    );
  }
  const different = [
    ['gpt-4o', 'gpt-4o-mini'],
    ['kimi-k2.8-preview', 'kimi-k2.8'],
    ['gpt-4', 'gpt-4o'],
    ['configured-only', 'gateway-served-id'],
  ];
  for (const [configured, reported] of different) {
    assert.ok(
      !reportedModelMatchesConfigured(configured, reported),
      `${configured} vs ${reported} must stay a mismatch`
    );
  }
}

// ─── Built-in gateway wording wins over a differing reported id ──────────────
{
  const previousConfigDir = process.env.MOSS_CONFIG_DIR;
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-info-'));
  process.env.MOSS_CONFIG_DIR = configDir;
  try {
    const bundled = createModelInfoTool({
      provider: () => ({
        complete: async () => ({ stopReason: 'end_turn', content: [], model: 'real-backing' }),
      }),
      config: () => ({
        model: 'Moss',
        baseUrl: 'https://example.com',
        usingBundledDefault: true,
      }),
      getReportedModel: () => 'some-other-id',
    });
    const result = await bundled.execute({ input: {} });
    assert.match(result, /real-backing \(served via the built-in model gateway\)/);
    assert.doesNotMatch(result, /gateway reported/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.MOSS_CONFIG_DIR;
    else process.env.MOSS_CONFIG_DIR = previousConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

console.log('✓ model-info-tool: reports live model after in-session switch');
