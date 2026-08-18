#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { ConfigManager } from '../dist/cli/config-manager.js';
import { CliServices } from '../dist/cli/cli-services.js';
import { MossWebSettingsService } from '../dist/web-ui/web-settings-service.js';

function createAgent(workspaceDir) {
  return new MossAgent({
    llmProvider: {
      id: 'settings-test',
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [] };
      },
    },
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    model: 'current-model',
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
}

test('Web settings validates and persists supported sections without returning credentials', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss web settings 空格 '));
  const configPath = path.join(tempDir, 'config', 'config.json');
  const env = { ...process.env, MOSS_CONFIG_DIR: path.dirname(configPath) };
  const config = new ConfigManager(env);
  const services = new CliServices(config);
  const agent = createAgent(tempDir);
  const settings = new MossWebSettingsService(agent, services, { configPath });
  try {
    const invalid = settings.validate('permissions', {
      safetyMode: 'anything-goes',
      approvalPolicy: 'prompt',
    });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.safetyMode, /read-only/);

    const saved = settings.save('permissions', {
      safetyMode: 'workspace-write',
      approvalPolicy: 'prompt',
      trustedTools: ['read_file'],
      deniedTools: ['exec'],
    });
    assert.equal(saved.valid, true);
    assert.equal(saved.dirty, false);

    settings.writeCredential('apiKey', 'secret-value-for-test');
    const models = await settings.section('models');
    assert.equal(models.values.apiKey, undefined);
    assert.equal(models.credentials.apiKey.configured, true);
    assert.equal(
      JSON.stringify(await settings.snapshot()).includes('secret-value-for-test'),
      false
    );

    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.notEqual(raw.apiKey, 'secret-value-for-test', 'credential is encrypted at rest');
    settings.deleteCredential('apiKey');
    assert.equal((await settings.section('models')).credentials.apiKey.configured, false);
  } finally {
    await agent.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Web settings model catalog delegates to CliServices and selection is persisted', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-model-settings-'));
  const configPath = path.join(tempDir, 'config.json');
  const agent = createAgent(tempDir);
  const fakeServices = {
    config: new ConfigManager({ ...process.env, MOSS_CONFIG_FILE: configPath }),
    models: {
      async loadModelChoicesForRuntime() {
        return {
          choices: [
            { id: 'model-a', label: 'Model A', provider: 'openai' },
            { id: 'model-b', label: 'Model B', provider: 'openai' },
          ],
          source: 'test catalog',
        };
      },
      resolveModelSelection(input, choices) {
        return choices.find(({ id }) => id === input) ?? null;
      },
    },
  };
  const settings = new MossWebSettingsService(agent, fakeServices, { configPath });
  try {
    const catalog = await settings.modelCatalog();
    assert.deepEqual(
      catalog.choices.map(({ id }) => id),
      ['model-a', 'model-b']
    );
    const selected = await settings.selectModel('model-b');
    assert.equal(selected.model, 'model-b');
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).model, 'model-b');
    await assert.rejects(settings.selectModel('missing'), /unknown model/);
  } finally {
    await agent.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
