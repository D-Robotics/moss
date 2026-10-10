#!/usr/bin/env node
/** An unset apiKeyEnv names the variable and does not fall through to a stored key. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCliConfig } from '../dist/cli/config.js';
import { formatUnsetApiKeyEnv } from '../dist/cli/onboarding-hints.js';
import { captureEnvBeforeDotenv } from '../dist/utils/startup-env.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

const userConfig = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'stored-key-must-not-be-used',
  apiKeyEnv: 'MOSS_TEST_UNSET_KEY',
};

{
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    userConfig,
    {},
    {
      userConfig,
      config: userConfig,
    }
  );
  assert.equal(resolved.apiKeyEnvUnset, true);
  assert.equal(resolved.apiKeyEnv, 'MOSS_TEST_UNSET_KEY');
  assert.equal(resolved.apiKey, '');
  const text = formatUnsetApiKeyEnv(resolved.apiKeyEnv);
  assert.match(text, /MOSS_TEST_UNSET_KEY is not set/);
  assert.match(text, /export MOSS_TEST_UNSET_KEY='your-key'/);
  assert.doesNotMatch(text, /stored-key/);
}

{
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1', MOSS_TEST_UNSET_KEY: 'from-env' },
    userConfig,
    {},
    { userConfig, config: userConfig }
  );
  assert.equal(resolved.apiKeyEnvUnset, undefined);
  assert.equal(resolved.apiKey, 'from-env');
}

{
  captureEnvBeforeDotenv({ MOSS_NO_BUNDLED_DEFAULT: '1' });
  const resolved = resolveCliConfig(
    process.env,
    userConfig,
    {},
    { userConfig, config: userConfig }
  );
  assert.equal(resolved.apiKey, '');
  assert.equal(resolved.apiKeyEnvUnset, true);
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-apikeyenv-'));
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com',
      apiKey: 'stored-key-must-not-be-used',
      apiKeyEnv: 'MOSS_TEST_UNSET_KEY',
    })
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) || key.startsWith('MOSS_')) delete env[key];
  }
  env.PATH = process.env.PATH ?? '';
  env.HOME = home;
  env.MOSS_CONFIG_DIR = configDir;
  env.MOSS_NO_BUNDLED_DEFAULT = '1';
  env.MOSS_NO_RDK_DOCS = '1';
  const result = spawnSync(process.execPath, [cli, '--mock', '-p', 'ping'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 3, text);
  assert.match(text, /MOSS_TEST_UNSET_KEY is not set/);
  assert.match(text, /export MOSS_TEST_UNSET_KEY='your-key'/);
  assert.doesNotMatch(text, /stored-key/);
}

console.log('[PASS] apiKeyEnv unset');
