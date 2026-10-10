#!/usr/bin/env node
/**
 * buildApiV1Url accepts an API root with or without a trailing /v1
 * and never emits /v1/v1. The d-robotics preset base URL is one of the inputs.
 */
import assert from 'node:assert/strict';

import { buildApiV1Url } from '../dist/provider/api-v1-url.js';
import { PROVIDER_PRESETS } from '../dist/provider/provider-presets.js';

const preset = PROVIDER_PRESETS['d-robotics'].defaultBaseUrl;
assert.equal(preset, 'https://ai-api.d-robotics.cc/v1');

const cases = [
  ['https://gw.example', 'https://gw.example'],
  ['https://gw.example/', 'https://gw.example'],
  ['https://gw.example/v1', 'https://gw.example'],
  ['https://gw.example/v1/', 'https://gw.example'],
  [preset, 'https://ai-api.d-robotics.cc'],
  ['https://gw.example/v1/chat/completions', 'https://gw.example'],
];

for (const [base, root] of cases) {
  const chat = buildApiV1Url(base, 'chat/completions');
  const models = buildApiV1Url(base, 'models');
  assert.equal(chat, `${root}/v1/chat/completions`, base);
  assert.equal(models, `${root}/v1/models`, base);
  assert.equal(chat.includes('/v1/v1'), false, chat);
  assert.equal(models.includes('/v1/v1'), false, models);
}

assert.equal(
  buildApiV1Url('https://gw.example', '/chat/completions'),
  'https://gw.example/v1/chat/completions'
);
assert.equal(
  buildApiV1Url('https://gw.example/v1/chat/completions', '/models'),
  'https://gw.example/v1/models'
);
assert.equal(
  buildApiV1Url('https://gw.example/v1/', '/chat/completions').includes('/v1/v1'),
  false
);

console.log('[PASS] buildApiV1Url');
