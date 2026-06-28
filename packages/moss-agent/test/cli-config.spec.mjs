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
  resolveConfigPath,
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
    assert.ok(result.includes('moss') || result.includes('dmoss'), 'default config dir includes moss in the path');
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
      'malformed JSON throws CliConfigFileError',
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
    assert.ok(encrypted.apiKey !== original.apiKey, 'API key is encrypted (different from original)');
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
      assert.ok(preset.defaultBaseUrl && preset.defaultBaseUrl.startsWith('https://'), `${name} defaultBaseUrl is HTTPS`);
    }
  }
}

{
  // deepseek is the default provider and has correct defaults
  const deepseek = PROVIDER_PRESETS['deepseek'];
  assert.ok(deepseek.defaultBaseUrl.includes('deepseek'), 'DeepSeek preset uses deepseek API URL');
  assert.ok(deepseek.defaultModel.includes('deepseek'), 'DeepSeek preset has a deepseek model as default');
}

{
  // anthropic uses the Anthropic API
  const anthropic = PROVIDER_PRESETS['anthropic'];
  assert.ok(anthropic.defaultBaseUrl.includes('anthropic'), 'Anthropic preset uses anthropic.com URL');
}

{
  // openai-compatible has empty defaults (user must configure their own endpoint)
  const compat = PROVIDER_PRESETS['openai-compatible'];
  assert.equal(compat.defaultModel, '', 'openai-compatible has empty defaultModel (user must configure)');
}

// ─── resolveCliConfig — per-model context window resolution ──────────────────

{
  // GLM-4/5 native context window is 128k (name-based fallback).
  // The provider API may return a larger value if the gateway extends it;
  // users can also override with agent.contextTokens.
  const resolved = resolveCliConfig(
    {},
    { provider: 'openai-compatible', model: 'glm-5.2', baseUrl: 'https://example/v1', apiKey: 'k' }
  );
  assert.equal(resolved.contextTokens, 1_000_000, 'glm-5.2 resolves to a 1M context window (native)');
  assert.equal(resolved.contextTokensSource, 'model', 'glm-5.2 window source is the model');
}

{
  // DeepSeek V2/V3 native context window is 64k (name-based fallback).
  const resolved = resolveCliConfig(
    {},
    { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'k' }
  );
  assert.equal(resolved.contextTokens, 64_000, 'deepseek resolves to a 64k context window (native)');
  assert.equal(resolved.contextTokensSource, 'model', 'deepseek window source is the model');
}

{
  // Anthropic Claude is carved out to its real 200k default window.
  const resolved = resolveCliConfig(
    {},
    { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' }
  );
  assert.equal(resolved.contextTokens, 200_000, 'claude keeps its 200k window');
  assert.equal(resolved.contextTokensSource, 'model', 'claude window source is the model');
}

{
  // Built-in OpenAI models are carved out to their real 128k window.
  const resolved = resolveCliConfig(
    {},
    { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k' }
  );
  assert.equal(resolved.contextTokens, 128_000, 'gpt-4o-mini keeps its 128k window');
  assert.equal(resolved.contextTokensSource, 'model', 'gpt window source is the model');
}

{
  // An explicit agent.contextTokens still wins over the per-model window.
  const resolved = resolveCliConfig(
    {},
    { provider: 'openai-compatible', model: 'glm-5.2', baseUrl: 'https://example/v1', apiKey: 'k', agent: { contextTokens: 500_000 } }
  );
  assert.equal(resolved.contextTokens, 500_000, 'explicit agent.contextTokens overrides model window');
  assert.equal(resolved.contextTokensSource, 'config', 'explicit window source is config');
}

console.log('[PASS] Configuration management');
