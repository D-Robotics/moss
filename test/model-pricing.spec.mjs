#!/usr/bin/env node
/**
 * Per-model pricing: official-host list prices, gateway unknown, config
 * overrides, the estimate label, and headless total_cost_usd.
 */
import assert from 'node:assert/strict';

import { mergeConfigFiles } from '../dist/cli/config.js';
import {
  formatCostAmount,
  formatCostEstimate,
  lookupModelPrice,
  priceSourceLine,
  pricingOverridesFromConfig,
  quoteUsage,
  resetUnknownPriceNoticeForTests,
  takeUnknownPriceNotice,
  unknownPriceMessage,
} from '../dist/cli/model-pricing.js';
import { createHeadlessPrintState, formatHeadlessStreamEvent } from '../dist/cli/print.js';

const million = { inputTokens: 1_000_000, outputTokens: 0 };
const deepseek = 'https://api.deepseek.com';
const openai = 'https://api.openai.com/v1';
const anthropic = 'https://api.anthropic.com';
const gateway = 'https://ai-api.d-robotics.cc/v1';

{
  const flash = quoteUsage([{ ...million, model: 'deepseek-v4-flash' }], { baseUrl: deepseek });
  assert.equal(
    flash.totalUsd,
    0.3,
    'deepseek-v4-flash input uses the peak rate, not off-peak $0.15'
  );
  assert.equal(flash.currency, 'USD');
  assert.equal(flash.source, 'builtin');
  assert.match(priceSourceLine(flash) ?? '', /DeepSeek peak \(standard, not off-peak\)/);
  assert.match(priceSourceLine(flash) ?? '', /checked 2026-10-09/);
  assert.match(priceSourceLine(flash, true) ?? '', /高峰标准价/);
  assert.match(priceSourceLine(flash, true) ?? '', /2026-10-09/);
  const cached = quoteUsage(
    [{ model: 'deepseek-v4-flash', inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }],
    { baseUrl: `${deepseek}/v1` }
  );
  assert.equal(cached.totalUsd, 0.006, 'deepseek cache hits use the peak cache-hit rate');
  const out = quoteUsage([{ model: 'deepseek-v4-pro', inputTokens: 0, outputTokens: 1_000_000 }], {
    baseUrl: deepseek,
  });
  assert.equal(out.totalUsd, 3.96, 'deepseek-v4-pro output is the peak rate');
  const both = quoteUsage(
    [
      {
        model: 'gpt-4o-mini',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      },
    ],
    { baseUrl: openai }
  );
  assert.equal(both.totalUsd, 0.15 + 0.6 + 0.075, 'input, output, and cached add');
  assert.equal(
    quoteUsage([{ ...million, model: 'gpt-4o-mini' }], { baseUrl: openai }).totalUsd,
    0.15,
    'gpt-4o-mini does not inherit the gpt-4o rate'
  );
  assert.equal(
    quoteUsage([{ ...million, model: 'claude-sonnet-4-20250514' }], { baseUrl: anthropic })
      .totalUsd,
    3,
    'dated sonnet snapshots match the claude-sonnet-4 family'
  );
  assert.equal(
    quoteUsage([{ ...million, model: 'qwen3.6-plus' }], {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    }).totalUsd,
    0.276,
    'Beijing DashScope uses the Beijing list price'
  );
  assert.equal(
    quoteUsage([{ ...million, model: 'qwen3.6-plus' }], {
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    }).totalUsd,
    0.5,
    'international DashScope uses the international list price'
  );
  assert.equal(formatCostAmount(0.15, 'USD'), '$0.15');
  assert.equal(formatCostAmount(0.00412, 'USD'), '$0.00412');
  assert.equal(formatCostAmount(2, 'CNY'), '¥2.00');
  assert.equal(formatCostEstimate(0.15, 'USD'), '~$0.15 (est.)');
  assert.equal(formatCostEstimate(0.15, 'USD', true), '~$0.15 (估算)');
  assert.equal(formatCostEstimate(2, 'CNY', true), '约 ¥2.00 (估算)');
}

{
  const overrides = pricingOverridesFromConfig({
    models: {
      'deepseek-v4-flash': { input: 9, output: 9, currency: 'USD' },
      'gateway/custom': { input: 2, output: 8, cached: 0.5, currency: 'CNY' },
      'deepseek-flash': { input: 1, output: 2, currency: 'USD' },
      broken: { input: 'nope', output: 1 },
    },
  });
  assert.equal(
    quoteUsage([{ ...million, model: 'deepseek-v4-flash' }], { overrides, baseUrl: gateway })
      .totalUsd,
    9,
    'a config price wins on a gateway'
  );
  const configQuote = quoteUsage([{ ...million, model: 'deepseek-flash' }], {
    overrides,
    baseUrl: gateway,
  });
  assert.equal(configQuote.totalUsd, 1);
  assert.equal(configQuote.source, 'config');
  assert.match(priceSourceLine(configQuote) ?? '', /your config \(pricing\.models\)/);
  assert.match(priceSourceLine(configQuote, true) ?? '', /你的配置/);
  const cny = quoteUsage(
    [
      {
        model: 'gateway/custom',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 1_000_000,
      },
    ],
    { overrides, baseUrl: gateway }
  );
  assert.equal(cny.totalUsd, null, 'CNY prices are not converted into a fake USD total');
  assert.equal(cny.currency, 'CNY');
  assert.equal(cny.amount, 2 + 4 + 0.5);
  assert.equal(overrides.broken, undefined, 'a non-numeric price is dropped');
  const merged = mergeConfigFiles(
    { pricing: { models: { 'gateway/custom': { input: 1, output: 1, currency: 'USD' } } } },
    { pricing: { models: { 'gateway/custom': { input: 3, output: 4, currency: 'CNY' } } } }
  );
  assert.equal(merged.pricing.models['gateway/custom'].input, 3, 'user price wins over project');
}

{
  const onGateway = quoteUsage([{ ...million, model: 'deepseek-flash' }], { baseUrl: gateway });
  assert.equal(onGateway.amount, null, 'a gateway serving deepseek-flash is unpriced');
  assert.equal(onGateway.totalUsd, null);
  assert.equal(onGateway.unknownModel, 'deepseek-flash');
  const legacyOnGateway = quoteUsage([{ ...million, model: 'deepseek-v4-flash' }], {
    baseUrl: gateway,
  });
  assert.equal(
    legacyOnGateway.totalUsd,
    null,
    'the built-in flash price does not apply off api.deepseek.com'
  );
  const aliasOnOfficial = quoteUsage([{ ...million, model: 'deepseek-flash' }], {
    baseUrl: deepseek,
  });
  assert.equal(aliasOnOfficial.totalUsd, null, 'deepseek-flash is not a built-in row');
  const noHost = quoteUsage([{ ...million, model: 'gpt-4o-mini' }]);
  assert.equal(noHost.totalUsd, null, 'built-in prices need an official host');
  const wrongHost = quoteUsage([{ ...million, model: 'deepseek-v4-flash' }], { baseUrl: openai });
  assert.equal(wrongHost.totalUsd, null, 'an OpenAI host does not unlock DeepSeek prices');
  assert.equal(lookupModelPrice('deepseek-v4-flash', { baseUrl: gateway }), null);
  assert.equal(lookupModelPrice('deepseek-flash', { baseUrl: deepseek }), null);
  assert.ok(lookupModelPrice('deepseek-v4-flash', { baseUrl: deepseek }));

  const unknown = quoteUsage([{ model: 'moss-gateway', inputTokens: 500, outputTokens: 20 }]);
  assert.equal(unknown.amount, null);
  assert.equal(unknown.totalUsd, null);
  assert.equal(unknown.unknownModel, 'moss-gateway');
  assert.match(unknownPriceMessage('moss-gateway'), /^price unknown, set it with /);
  assert.match(unknownPriceMessage('moss-gateway', true), /pricing\.models/);
  const envPriced = quoteUsage([{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 4000 }], {
    env: { MOSS_PRICE_IN: '1', MOSS_PRICE_OUT: '2' },
  });
  assert.equal(envPriced.totalUsd, 0.00412, 'MOSS_PRICE_IN/OUT still prices an unnamed model');
  assert.equal(envPriced.source, 'env');
  assert.match(priceSourceLine(envPriced) ?? '', /MOSS_PRICE_IN \/ MOSS_PRICE_OUT/);
  resetUnknownPriceNoticeForTests();
  assert.match(takeUnknownPriceNotice('moss-gateway') ?? '', /^price unknown, set it with /);
  assert.equal(takeUnknownPriceNotice('other'), null, 'the unsolicited notice is once per process');
}

{
  delete process.env.MOSS_PRICE_IN;
  delete process.env.MOSS_PRICE_OUT;
  const priced = createHeadlessPrintState({
    sessionId: 'priced',
    model: 'gpt-4o-mini',
    baseUrl: openai,
  });
  formatHeadlessStreamEvent(priced, {
    type: 'llm_usage',
    inputTokens: 1_000_000,
    outputTokens: 0,
    model: 'gpt-4o-mini',
  });
  formatHeadlessStreamEvent(priced, {
    type: 'llm_usage',
    inputTokens: 0,
    outputTokens: 1_000_000,
    model: 'gpt-4o-mini',
  });
  const result = formatHeadlessStreamEvent(priced, {
    type: 'done',
    result: { response: 'ok', stopReason: 'end_turn' },
  }).at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.total_cost_usd, 0.75, 'headless JSON sums priced calls into total_cost_usd');
  assert.equal(result.cost_unavailable, false);
  assert.equal(result.cost_currency, 'USD');

  const gatewayRun = createHeadlessPrintState({
    sessionId: 'gateway',
    model: 'deepseek-flash',
    baseUrl: gateway,
  });
  formatHeadlessStreamEvent(gatewayRun, {
    type: 'llm_usage',
    inputTokens: 1_000_000,
    outputTokens: 0,
    model: 'deepseek-flash',
  });
  const gatewayResult = formatHeadlessStreamEvent(gatewayRun, {
    type: 'done',
    result: { response: 'ok', stopReason: 'end_turn' },
  }).at(-1);
  assert.equal(gatewayResult.total_cost_usd, null, 'gateway JSON does not invent a DeepSeek price');
  assert.equal(gatewayResult.cost_unavailable, true);
  assert.equal(gatewayResult.total_cost, undefined);

  const unknown = createHeadlessPrintState({ sessionId: 'unknown', model: 'gateway-x' });
  formatHeadlessStreamEvent(unknown, {
    type: 'llm_usage',
    inputTokens: 1000,
    outputTokens: 10,
    model: 'gateway-x',
  });
  const unknownResult = formatHeadlessStreamEvent(unknown, {
    type: 'done',
    result: { response: 'ok', stopReason: 'end_turn' },
  }).at(-1);
  assert.equal(unknownResult.total_cost_usd, null);
  assert.equal(unknownResult.cost_unavailable, true);
  assert.equal(unknownResult.total_cost, undefined, 'unknown pricing adds no numeric cost');

  const cny = createHeadlessPrintState({
    sessionId: 'cny',
    model: 'gateway-x',
    baseUrl: gateway,
    pricingOverrides: {
      'gateway-x': { input: 2, output: 8, cached: 0.5, currency: 'CNY' },
    },
  });
  formatHeadlessStreamEvent(cny, {
    type: 'llm_usage',
    inputTokens: 1_000_000,
    outputTokens: 0,
    model: 'gateway-x',
  });
  const cnyResult = formatHeadlessStreamEvent(cny, {
    type: 'done',
    result: { response: 'ok', stopReason: 'end_turn' },
  }).at(-1);
  assert.equal(cnyResult.total_cost_usd, null);
  assert.equal(cnyResult.total_cost, 2);
  assert.equal(cnyResult.cost_currency, 'CNY');
  assert.equal(lookupModelPrice('gateway-x'), null);
}

console.log('[PASS] model pricing');
