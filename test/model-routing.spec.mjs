#!/usr/bin/env node
/**
 * Model routing (v0.12) — locks the tier resolver, env wiring, and the
 * per-request model override at the provider adapter.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const DEFAULT = 'deepseek-pro@latest';

test('resolver: no tiers (or all empty) keeps the configured model', async () => {
  const { resolveRoutedModel } = await import('../dist/core/loop/agent-loop-types.js');
  assert.equal(
    resolveRoutedModel({ tiers: undefined, defaultModel: DEFAULT, pressure: true }),
    DEFAULT
  );
  assert.equal(resolveRoutedModel({ tiers: {}, defaultModel: DEFAULT, pressure: false }), DEFAULT);
});

test('resolver: clean rounds ride cheap, pressure escalates to strong', async () => {
  const { resolveRoutedModel } = await import('../dist/core/loop/agent-loop-types.js');
  const tiers = { cheap: 'deepseek-flash@latest', strong: 'deepseek-v4-pro@latest' };
  assert.equal(resolveRoutedModel({ tiers, defaultModel: DEFAULT, pressure: false }), tiers.cheap);
  assert.equal(resolveRoutedModel({ tiers, defaultModel: DEFAULT, pressure: true }), tiers.strong);
});

test('resolver: partial tiers fall back without inventing models', async () => {
  const { resolveRoutedModel } = await import('../dist/core/loop/agent-loop-types.js');
  // cheap only: strong falls back to cheap, so pressure stays on cheap
  const cheapOnly = { cheap: 'flash' };
  assert.equal(
    resolveRoutedModel({ tiers: cheapOnly, defaultModel: DEFAULT, pressure: true }),
    'flash'
  );
  // strong only: clean rounds keep the configured default
  const strongOnly = { strong: 'pro-max' };
  assert.equal(
    resolveRoutedModel({ tiers: strongOnly, defaultModel: DEFAULT, pressure: false }),
    DEFAULT
  );
  assert.equal(
    resolveRoutedModel({ tiers: strongOnly, defaultModel: DEFAULT, pressure: true }),
    'pro-max'
  );
  // balanced acts as the strong fallback when no strong tier exists
  const cheapBalanced = { cheap: 'flash', balanced: 'pro' };
  assert.equal(
    resolveRoutedModel({ tiers: cheapBalanced, defaultModel: DEFAULT, pressure: true }),
    'pro'
  );
});

test('wiring: MOSS_MODEL_CHEAP/BALANCED/STRONG resolve through config', async () => {
  const { resolveCliConfig } = await import('../dist/cli/config.js');
  assert.deepEqual(
    resolveCliConfig({
      MOSS_MODEL_CHEAP: 'deepseek-flash@latest',
      MOSS_MODEL_STRONG: 'deepseek-v4-pro@latest',
    }).modelTiers,
    { cheap: 'deepseek-flash@latest', strong: 'deepseek-v4-pro@latest' }
  );
  assert.deepEqual(resolveCliConfig({ MOSS_MODEL_BALANCED: 'pro' }).modelTiers, {
    balanced: 'pro',
  });
  // blank env must not create empty-string tiers
  assert.deepEqual(resolveCliConfig({ MOSS_MODEL_CHEAP: '  ' }).modelTiers, undefined);
  assert.equal(resolveCliConfig({}).modelTiers, undefined);
});

test('adapter: a per-request model id overrides the provider model, same id is a no-op', async () => {
  const { PiAiLLMProvider } = await import('../dist/provider/pi-ai-adapter.js');
  const provider = new PiAiLLMProvider({
    streamFn: () => {
      throw new Error('not called in this test');
    },
    model: { provider: 'test-gateway', id: DEFAULT },
    apiKey: 'test-key',
  });
  const build = (options) => provider.buildPiModelForCall(options, false);
  const routed = build({ model: 'deepseek-flash@latest' });
  assert.equal(routed.id, 'deepseek-flash@latest');
  assert.equal(routed.provider, 'test-gateway', 'gateway/auth context is preserved');
  assert.equal(build({}).id, DEFAULT, 'no override keeps the configured model');
  assert.equal(build({ model: DEFAULT }).id, DEFAULT, 'same id is a no-op');
});

test('adapter: llm_usage events carry the per-call model through the agent event surface', async () => {
  const { createMossAgentLoopEventAdapter } = await import('../dist/core/agent/index.js');
  const adapter = createMossAgentLoopEventAdapter();
  const events = adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 100,
    outputTokens: 10,
    model: 'deepseek-flash@latest',
  });
  const usage = events.find((e) => e.type === 'llm_usage');
  assert.equal(usage?.model, 'deepseek-flash@latest');
});

console.log('[PASS] model routing');
