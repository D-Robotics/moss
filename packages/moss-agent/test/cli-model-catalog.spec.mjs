#!/usr/bin/env node
/**
 * Model catalog and selection — tested from the user's perspective:
 * can the user pick models from the /model command?
 */
import assert from 'node:assert/strict';

import {
  commonModelChoices,
  resolveModelSelection,
  formatModelChoices,
  parseCustomModelConfigInput,
} from '../dist/cli/model-catalog.js';

// ─── commonModelChoices — model list for the picker ──────────────────────────

{
  const choices = commonModelChoices('deepseek');
  assert.ok(Array.isArray(choices), 'returns an array of model choices');
  assert.ok(choices.length > 0, 'at least one model choice for deepseek');
  for (const choice of choices) {
    assert.ok(choice.model, 'each choice has a model name');
    assert.ok(choice.provider, 'each choice has a provider');
  }
}

{
  // Current model is included in the choices
  const choices = commonModelChoices('deepseek', 'deepseek-v4-pro');
  assert.ok(
    choices.some((c) => c.model === 'deepseek-v4-pro'),
    'current model appears in the list'
  );
  const currentChoice = choices.find((c) => c.model === 'deepseek-v4-pro');
  assert.equal(currentChoice?.source, 'current', 'current model is tagged with source: current');
}

{
  // Built-in default is included when using bundled gateway
  const choices = commonModelChoices('deepseek', '', { usingBundledDefault: true });
  assert.ok(
    choices.some((c) => c.model === 'Moss'),
    'built-in Moss model appears when using bundled default'
  );
}

// ─── resolveModelSelection — selecting a model by number or name ──────────────

{
  const choices = [
    { model: 'deepseek-v4-flash', provider: 'deepseek', source: 'common' },
    { model: 'deepseek-v4-pro', provider: 'deepseek', source: 'common' },
    { model: 'gpt-4o', provider: 'openai', source: 'common' },
  ];

  // Select by number
  const byNumber = resolveModelSelection('1', choices);
  assert.ok(byNumber !== null, 'selection by number works');
  assert.equal(byNumber.model, 'deepseek-v4-flash', 'number 1 selects the first model');

  const byNumber2 = resolveModelSelection('2', choices);
  assert.equal(byNumber2?.model, 'deepseek-v4-pro', 'number 2 selects the second model');
}

{
  const choices = [
    { model: 'deepseek-v4-flash', provider: 'deepseek', source: 'common' },
    { model: 'gpt-4o', provider: 'openai', source: 'common' },
  ];

  // Select by exact model name
  const byName = resolveModelSelection('gpt-4o', choices);
  assert.ok(byName !== null, 'selection by model name works');
  assert.equal(byName.model, 'gpt-4o', 'exact name match selects correct model');

  // Case-insensitive name matching
  const byNameUpper = resolveModelSelection('GPT-4O', choices);
  assert.ok(byNameUpper !== null, 'name matching is case-insensitive');
  assert.equal(byNameUpper.model, 'gpt-4o');
}

{
  // Out-of-range number returns null
  const choices = [{ model: 'deepseek-v4-flash', provider: 'deepseek', source: 'common' }];
  assert.equal(resolveModelSelection('99', choices), null, 'out-of-range number returns null');
  assert.equal(resolveModelSelection('0', choices), null, 'number 0 returns null');
  assert.equal(
    resolveModelSelection('unknown-model', choices),
    null,
    'unknown model name returns null'
  );
}

// ─── parseCustomModelConfigInput — /model config command ─────────────────────

{
  // Parsing a custom model config from the /model config line
  const result = parseCustomModelConfigInput(
    'base_url=https://api.example.com key=sk-test model_name=my-model'
  );
  assert.ok(result.ok, 'valid config parses without error');
  if (result.ok) {
    assert.equal(result.config.baseUrl, 'https://api.example.com', 'baseUrl is parsed');
    assert.equal(result.config.apiKey, 'sk-test', 'apiKey is parsed');
    assert.equal(result.config.model, 'my-model', 'model name is parsed');
  }
}

{
  // Missing required fields should return an error
  const result = parseCustomModelConfigInput('');
  assert.ok(!result.ok, 'empty input is an error');
}

// ─── formatModelChoices — the /model output ───────────────────────────────────

{
  const list = {
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    currentModel: 'deepseek-v4-flash',
    choices: [
      { model: 'deepseek-v4-flash', provider: 'deepseek', source: 'current' },
      { model: 'deepseek-v4-pro', provider: 'deepseek', source: 'common' },
    ],
    source: 'common',
    usingBundledDefault: false,
  };
  const formatted = formatModelChoices(list);
  assert.ok(formatted.includes('Models'), 'output starts with "Models" header');
  assert.ok(formatted.includes('deepseek-v4-flash'), 'shows current model');
  assert.ok(formatted.includes('deepseek-v4-pro'), 'shows alternative model');
  assert.ok(formatted.includes('/model'), 'shows usage instructions');
  assert.ok(formatted.includes('moss setup'), 'shows how to reconfigure');
  assert.ok(
    !formatted.includes('image_input'),
    'help does not advertise an unsupported image capability flag'
  );
}

console.log('[PASS] Model catalog and selection');
