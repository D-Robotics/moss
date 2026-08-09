#!/usr/bin/env node
/**
 * Configuration management — tested from the user's perspective:
 * does config read/write work correctly, are defaults sensible?
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveConfigDir,
  loadConfigFile,
  PROVIDER_PRESETS,
  maybeEncryptApiKeyInConfig,
  maybeDecryptApiKeyInConfig,
  resolveCliConfig,
} from '../dist/cli/config.js';

// ─── resolveConfigDir — config directory location ────────────────────────────

{
  // MOSS_CONFIG_DIR env var overrides the default location
  const result = resolveConfigDir({ MOSS_CONFIG_DIR: '/custom/config' });
  assert.equal(result, '/custom/config', 'MOSS_CONFIG_DIR env var overrides config location');
}

{
  // Default config dir uses ~/.config/moss on non-Windows
  if (process.platform !== 'win32') {
    const result = resolveConfigDir({});
    assert.ok(
      result.includes('moss') || result.includes('dmoss'),
      'default config dir includes moss in the path'
    );
    assert.ok(path.isAbsolute(result), 'default config dir is absolute path');
  }
}

// ─── loadConfigFile — reading config from disk ────────────────────────────────

{
  // Non-existent config returns empty object (zero-config install)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfg-'));
  try {
    const configPath = path.join(tmpDir, 'config.json');
    const config = loadConfigFile(configPath);
    assert.deepEqual(config, {}, 'missing config file returns empty config');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  // Valid config file is parsed correctly
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfg-'));
  try {
    const configPath = path.join(tmpDir, 'config.json');
    const stored = { model: 'deepseek-v4-pro', provider: 'deepseek' };
    fs.writeFileSync(configPath, JSON.stringify(stored), 'utf8');
    const config = loadConfigFile(configPath);
    assert.equal(config.model, 'deepseek-v4-pro', 'model is read from config');
    assert.equal(config.provider, 'deepseek', 'provider is read from config');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  // Malformed JSON throws CliConfigFileError (not silently ignored)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfg-'));
  try {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{ invalid json }', 'utf8');
    assert.throws(
      () => loadConfigFile(configPath),
      (err) => err.constructor.name === 'CliConfigFileError',
      'malformed JSON throws CliConfigFileError'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── API key encryption / decryption ─────────────────────────────────────────

{
  // Encrypting and decrypting an API key round-trips correctly
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfg-'));
  try {
    const original = { apiKey: 'sk-test-1234567890' };
    const encrypted = maybeEncryptApiKeyInConfig(original, tmpDir);
    assert.ok(
      encrypted.apiKey !== original.apiKey,
      'API key is encrypted (different from original)'
    );
    assert.ok(encrypted.apiKey.startsWith('enc:'), 'encrypted key starts with enc: prefix');

    const decrypted = maybeDecryptApiKeyInConfig(encrypted, tmpDir);
    assert.equal(decrypted.apiKey, 'sk-test-1234567890', 'decrypted key matches original');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  // Already-plain (non-encrypted) API key is returned as-is by decryption
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfg-'));
  try {
    const plain = { apiKey: 'sk-plain-key' };
    const result = maybeDecryptApiKeyInConfig(plain, tmpDir);
    assert.equal(result.apiKey, 'sk-plain-key', 'plain key is not modified');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  // Config without apiKey is not touched by encryption
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cfg-'));
  try {
    const config = { model: 'gpt-4o' };
    const result = maybeEncryptApiKeyInConfig(config, tmpDir);
    assert.equal(result.model, 'gpt-4o', 'config without apiKey is unchanged');
    assert.equal(result.apiKey, undefined, 'no apiKey field added');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── PROVIDER_PRESETS — provider routing table ────────────────────────────────

{
  for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
    assert.ok(preset.displayName, `${name} preset has displayName`);
    assert.ok(preset.id === name, `${name} preset id matches its key`);
    // openai-compatible has empty defaultBaseUrl by design (user must provide one)
    if (name !== 'openai-compatible') {
      assert.ok(
        preset.defaultBaseUrl && preset.defaultBaseUrl.startsWith('https://'),
        `${name} defaultBaseUrl is HTTPS`
      );
    }
  }
}

{
  // deepseek is the default provider and has correct defaults
  const deepseek = PROVIDER_PRESETS['deepseek'];
  assert.ok(deepseek.defaultBaseUrl.includes('deepseek'), 'DeepSeek preset uses deepseek API URL');
  assert.ok(
    deepseek.defaultModel.includes('deepseek'),
    'DeepSeek preset has a deepseek model as default'
  );
}

{
  // anthropic uses the Anthropic API
  const anthropic = PROVIDER_PRESETS['anthropic'];
  assert.ok(
    anthropic.defaultBaseUrl.includes('anthropic'),
    'Anthropic preset uses anthropic.com URL'
  );
}

{
  // openai-compatible has empty defaults (user must configure their own endpoint)
  const compat = PROVIDER_PRESETS['openai-compatible'];
  assert.equal(
    compat.defaultModel,
    '',
    'openai-compatible has empty defaultModel (user must configure)'
  );
}

// ─── resolveCliConfig — context-window probe: source is 'unprobed' by default ─

{
  const resolved = resolveCliConfig({ MOSS_NO_BUNDLED_DEFAULT: '1' }, {});
  assert.equal(resolved.profile, 'balanced', 'fresh CLI config defaults to the balanced profile');
  assert.equal(
    resolved.safetyMode,
    'workspace-write',
    'default profile is workspace-scoped (safe by default)'
  );
  assert.equal(resolved.approvalPolicy, 'prompt', 'default profile asks before sensitive actions');
}

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-bundled-config-'));
  try {
    const bundledPath = path.join(tmpDir, 'zero-config-default.json');
    fs.writeFileSync(
      bundledPath,
      JSON.stringify({
        provider: 'openai-compatible',
        model: 'bundled-model',
        baseUrl: 'https://bundled.example/v1',
        apiKey: 'bundled-key',
      }),
      'utf8'
    );
    const env = { MOSS_BUNDLED_DEFAULT_FILE: bundledPath };

    for (const partialConfig of [
      { provider: 'anthropic' },
      { model: 'project-model' },
      { baseUrl: 'https://project.example/v1' },
    ]) {
      const resolved = resolveCliConfig(env, partialConfig);
      assert.equal(
        resolved.usingBundledDefault,
        true,
        `${Object.keys(partialConfig)[0]}-only config keeps the bundled zero-config fallback`
      );
      assert.equal(resolved.provider, 'openai-compatible');
      assert.equal(resolved.model, 'bundled-model');
      assert.equal(resolved.baseUrl, 'https://bundled.example/v1');
      assert.equal(resolved.apiKey, 'bundled-key');
    }

    const optedOut = resolveCliConfig(
      { ...env, MOSS_NO_BUNDLED_DEFAULT: '1' },
      { provider: 'anthropic' }
    );
    assert.equal(
      optedOut.usingBundledDefault,
      false,
      'explicit opt-out disables the bundled fallback'
    );
    assert.equal(optedOut.provider, 'anthropic', 'explicit opt-out preserves partial user config');

    const fullyConfigured = resolveCliConfig(env, {
      provider: 'anthropic',
      model: 'claude-project-model',
      apiKey: 'project-key',
    });
    assert.equal(
      fullyConfigured.usingBundledDefault,
      false,
      'complete user model config suppresses the bundled fallback'
    );
    assert.equal(fullyConfigured.bundledDefaultSuppressedBy, 'moss config file');

    const customEndpoint = resolveCliConfig(env, {
      model: 'custom-project-model',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'custom-key',
    });
    assert.equal(
      customEndpoint.usingBundledDefault,
      false,
      'complete custom endpoint config suppresses the bundled fallback'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  // Without an explicit agent.contextTokens in config, resolveCliConfig no
  // longer calls the stale name-matching table. Source is 'unprobed'; the
  // real value is determined by the startup probe in cli-main (async, after
  // agent creation). contextTokens is the conservative default (32k) until
  // the probe succeeds.
  const resolved = resolveCliConfig(
    {},
    { provider: 'openai-compatible', model: 'glm-5.2', baseUrl: 'https://example/v1', apiKey: 'k' }
  );
  assert.equal(
    resolved.contextTokensSource,
    'unprobed',
    'without explicit contextTokens, source is unprobed (not model-name-matching)'
  );
  assert.equal(
    resolved.contextTokens,
    1_000_000,
    'without explicit contextTokens, contextTokens is the conservative 1M default'
  );
}

{
  // deepseek — same: source is 'unprobed'. (Formerly 64k from static table.)
  const resolved = resolveCliConfig(
    {},
    { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'k' }
  );
  assert.equal(
    resolved.contextTokensSource,
    'unprobed',
    'deepseek without explicit contextTokens → source is unprobed'
  );
  assert.equal(
    resolved.contextTokens,
    1_000_000,
    'deepseek without explicit contextTokens → conservative 1M (not the stale 64k from name-matching)'
  );
}

{
  // Anthropic Claude — also unprobed by default (200k was the static table guess).
  const resolved = resolveCliConfig(
    {},
    { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' }
  );
  assert.equal(resolved.contextTokensSource, 'unprobed');
  assert.equal(resolved.contextTokens, 1_000_000);
}

{
  // OpenAI — same.
  const resolved = resolveCliConfig({}, { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k' });
  assert.equal(
    resolved.contextTokens,
    1_000_000,
    'gpt-4o-mini without explicit contextTokens → unprobed default (1M)'
  );
  assert.equal(
    resolved.contextTokensSource,
    'unprobed',
    'gpt without explicit contextTokens → unprobed'
  );
}

{
  // An explicit agent.contextTokens still wins over the per-model window.
  const resolved = resolveCliConfig(
    {},
    {
      provider: 'openai-compatible',
      model: 'glm-5.2',
      baseUrl: 'https://example/v1',
      apiKey: 'k',
      agent: { contextTokens: 500_000 },
    }
  );
  assert.equal(
    resolved.contextTokens,
    500_000,
    'explicit agent.contextTokens overrides model window'
  );
  assert.equal(resolved.contextTokensSource, 'config', 'explicit window source is config');
}

console.log('[PASS] Configuration management');
