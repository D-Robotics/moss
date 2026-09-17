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

console.log('✓ model-info-tool: reports live model after in-session switch');
