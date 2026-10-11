#!/usr/bin/env node
/**
 * One official env key selects that provider. Several keys ask for --provider.
 * A project endpoint, a project .env, and --base-url without --provider do not
 * attach a shell key. --provider plus --base-url may.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveCliConfig } from '../dist/cli/config.js';
import { captureEnvBeforeDotenv, envBeforeDotenv } from '../dist/utils/startup-env.js';

const STUB = 'http://127.0.0.1:9/v1';

function loaded(userConfig = {}, projectConfig) {
  return {
    configPath: path.join(os.tmpdir(), 'moss-env-auto-config.json'),
    userConfig,
    ...(projectConfig ? { projectConfig } : {}),
  };
}

function resolve(env, config, overrides, files) {
  return resolveCliConfig(env, config, overrides, files);
}

test('one official key selects that provider and does not write config', () => {
  const resolved = resolve(
    { DEEPSEEK_API_KEY: 'sk-one', MOSS_NO_BUNDLED_DEFAULT: '1' },
    {},
    {},
    loaded()
  );
  assert.equal(resolved.apiKey, 'sk-one');
  assert.equal(resolved.apiKeySource, 'env:DEEPSEEK_API_KEY');
  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.baseUrl, 'https://api.deepseek.com');
  assert.equal(resolved.providerSource, 'env');
  assert.equal(resolved.usingBundledDefault, false);
  assert.equal(
    resolved.autoEnvNotice,
    '[moss] Using DEEPSEEK_API_KEY → deepseek @ https://api.deepseek.com'
  );
  assert.equal(resolved.envProviderCandidates, undefined);
});

test('one official key wins over a bundled default', () => {
  const file = path.join(os.tmpdir(), `moss-bundled-${process.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      provider: 'openai',
      model: 'bundled-model',
      baseUrl: STUB,
      apiKey: 'sk-bundled',
    })
  );
  try {
    const resolved = resolve(
      { OPENAI_API_KEY: 'sk-shell', MOSS_BUNDLED_DEFAULT_FILE: file },
      {},
      {},
      loaded()
    );
    assert.equal(resolved.apiKey, 'sk-shell');
    assert.equal(resolved.provider, 'openai');
    assert.equal(resolved.baseUrl, 'https://api.openai.com');
    assert.equal(resolved.usingBundledDefault, false);
    assert.match(resolved.autoEnvNotice ?? '', /OPENAI_API_KEY/);
    assert.doesNotMatch(resolved.autoEnvNotice ?? '', /127\.0\.0\.1/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('several official keys are listed and none is attached', () => {
  const resolved = resolve(
    {
      DEEPSEEK_API_KEY: 'sk-ds',
      OPENAI_API_KEY: 'sk-oa',
      ANTHROPIC_API_KEY: 'sk-an',
      MOSS_NO_BUNDLED_DEFAULT: '1',
    },
    {},
    {},
    loaded()
  );
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.autoEnvNotice, undefined);
  assert.deepEqual(resolved.envProviderCandidates, [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]);
  assert.equal(resolved.usingBundledDefault, false);
});

test('a project endpoint does not receive a shell key', () => {
  const project = { provider: 'openai', baseUrl: STUB, model: 'm', apiKeyEnv: 'OPENAI_API_KEY' };
  const resolved = resolve(
    { OPENAI_API_KEY: 'sk-oa', DEEPSEEK_API_KEY: 'sk-ds', MOSS_NO_BUNDLED_DEFAULT: '1' },
    project,
    {},
    loaded({}, project)
  );
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.autoEnvNotice, undefined);
  assert.notEqual(resolved.apiKeySource, 'env:OPENAI_API_KEY');
});

test('--base-url without --provider does not attach an official key', () => {
  const resolved = resolve(
    { OPENAI_API_KEY: 'sk-oa', MOSS_NO_BUNDLED_DEFAULT: '1' },
    {},
    { baseUrl: STUB, model: 'm' },
    loaded()
  );
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.baseUrl, STUB);
  assert.equal(resolved.autoEnvNotice, undefined);
});

test('--provider and --base-url may send that provider env key', () => {
  const resolved = resolve(
    { OPENAI_API_KEY: 'sk-oa', MOSS_NO_BUNDLED_DEFAULT: '1' },
    {},
    { provider: 'openai', baseUrl: STUB, model: 'm' },
    loaded()
  );
  assert.equal(resolved.apiKey, 'sk-oa');
  assert.equal(resolved.apiKeySource, 'env:OPENAI_API_KEY');
  assert.equal(resolved.baseUrl, STUB);
});

test('a user custom gateway does not receive a different provider key', () => {
  const user = { provider: 'openai-compatible', baseUrl: STUB, model: 'm' };
  const resolved = resolve(
    { DEEPSEEK_API_KEY: 'sk-ds', MOSS_NO_BUNDLED_DEFAULT: '1' },
    user,
    {},
    loaded(user)
  );
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.baseUrl, STUB);
});

test('a project .env key or base URL is not the auto selection', () => {
  const savedSnap = { ...envBeforeDotenv };
  const touched = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HTTPS_PROXY', 'DEEPSEEK_API_KEY'];
  const saved = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  try {
    captureEnvBeforeDotenv({
      PATH: process.env.PATH ?? '',
      HOME: os.homedir(),
      OPENAI_API_KEY: 'sk-shell-openai',
      MOSS_NO_BUNDLED_DEFAULT: '1',
    });
    process.env.OPENAI_API_KEY = 'sk-shell-openai';
    process.env.OPENAI_BASE_URL = STUB;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.DEEPSEEK_API_KEY = 'sk-attacker';
    const resolved = resolve(process.env, {}, {}, loaded());
    assert.equal(resolved.apiKey, 'sk-shell-openai');
    assert.equal(resolved.provider, 'openai');
    assert.equal(resolved.baseUrl, 'https://api.openai.com');
    assert.match(resolved.autoEnvNotice ?? '', /https:\/\/api\.openai\.com/);
    assert.equal(resolved.apiKeySource, 'env:OPENAI_API_KEY');
  } finally {
    captureEnvBeforeDotenv(savedSnap);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
