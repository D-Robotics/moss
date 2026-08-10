#!/usr/bin/env node
/**
 * Command registry — tested from the user's perspective:
 * are the right commands available, and are error messages helpful?
 */
import assert from 'node:assert/strict';

import {
  registryCommandNames,
  findRegistryCommand,
  runRegistryCommand,
  unknownSlashCommandLines,
} from '../dist/cli/commands/registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatDeviceConnectFailure,
  formatDeviceConnectProgress,
  parseDeviceConnectArgs,
} from '../dist/cli/device-connect.js';
import { logLLMUsage } from '../dist/observability/llm-usage.js';

// ─── registryCommandNames — built-in slash commands ──────────────────────────

{
  const names = registryCommandNames();
  assert.ok(Array.isArray(names), 'registryCommandNames returns an array');
  assert.ok(names.includes('/soul'), 'registry includes the persona management command');
  assert.ok(names.length > 0, 'there are registered commands');

  // Commands handled by the registry (others like /clear, /model are handled by the TUI chain)
  for (const cmd of ['/status', '/doctor', '/review', '/connect', '/disconnect', '/mcp']) {
    assert.ok(names.includes(cmd), `built-in registry command "${cmd}" is registered`);
  }
}

// ─── findRegistryCommand — command lookup ────────────────────────────────────

{
  const match = findRegistryCommand('/status');
  assert.ok(match !== null, '/status is a known command');
  assert.equal(match.args, '', 'no args from bare /status');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-registry-soul-'));
  const messages = [];
  try {
    const handled = await runRegistryCommand('/soul init', {
      agent: {},
      runtime: { configDir: path.join(workspace, 'global') },
      sessionKey: 'test',
      workspace,
      surface: 'tui',
      say: (kind, text) => messages.push({ kind, text }),
      prefillInput() {},
    });
    assert.equal(handled, true, '/soul init is dispatched by the shared registry');
    assert.equal(fs.existsSync(path.join(workspace, '.moss', 'soul.md')), true);
    assert.ok(messages[0].text.includes('soul.md'), 'creation response names the Soul file');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

{
  let opened = false;
  const handled = await runRegistryCommand('/soul', {
    agent: {},
    runtime: undefined,
    sessionKey: 'test',
    workspace: process.cwd(),
    surface: 'tui',
    say() {},
    prefillInput() {},
    openSoulPicker: () => {
      opened = true;
    },
  });
  assert.equal(handled, true);
  assert.equal(opened, true, 'bare /soul opens the TUI persona picker');
}

{
  // /connect is a registry command; args after the command name are captured
  const match = findRegistryCommand('/connect 192.168.1.100');
  assert.ok(match !== null, '/connect is a known registry command');
  assert.equal(match.args, '192.168.1.100', 'board IP is captured in args');
}

{
  const prompts = [];
  const messages = [];
  const handled = await runRegistryCommand('/connect 192.0.2.20', {
    agent: {},
    runtime: { device: null, deviceSession: null },
    sessionKey: 'test',
    workspace: process.cwd(),
    surface: 'tui',
    say: (kind, text) => messages.push({ kind, text }),
    prefillInput() {},
    promptInput: async (options) => {
      prompts.push(options);
      return prompts.length === 1 ? 'root' : null;
    },
  });
  assert.equal(handled, true);
  assert.equal(prompts.length, 2, '/connect asks for account and password before SSH');
  assert.equal(prompts[1].masked, true, 'password prompt is masked');
  assert.match(messages.at(-1).text, /cancelled.*password/i);
}

{
  const parsed = parseDeviceConnectArgs('192.0.2.1 --no-verify');
  assert.equal(parsed.verify, false);
  assert.match(formatDeviceConnectProgress(parsed.config, true), /Establishing persistent SSH/i);
  assert.doesNotMatch(formatDeviceConnectProgress(parsed.config, true), /Verifying SSH/i);
  const failure = formatDeviceConnectFailure(
    parsed.config,
    {
      ok: false,
      kind: 'unreachable',
      detail: 'Host is unreachable.',
    },
    { skippedPreflight: true }
  );
  assert.doesNotMatch(
    failure.message,
    /use --no-verify/i,
    'failure must not suggest the option the user already supplied'
  );
  assert.match(failure.message, /cannot bypass establishing the SSH connection/i);
}

{
  const parsed = parseDeviceConnectArgs('', {
    MOSS_DEVICE_HOST: '192.0.2.10',
    MOSS_DEVICE_USER: 'root',
    MOSS_DEVICE_NO_VERIFY: '1',
    MOSS_DEVICE_HYBRID: 'true',
  });
  assert.equal(parsed.config.host, '192.0.2.10');
  assert.equal(parsed.verify, false);
  assert.equal(parsed.mode, 'hybrid');
}

{
  const parsed = parseDeviceConnectArgs('', {});
  assert.match(parsed.error, /Usage: \/connect/);
}

{
  const messages = [];
  const handled = await runRegistryCommand('/context', {
    agent: {
      config: {
        model: 'test-model',
        contextTokens: 100_000,
        sessionStore: { loadMessages: async () => [{ role: 'user', content: 'hello' }] },
      },
    },
    runtime: undefined,
    sessionKey: 'test',
    workspace: process.cwd(),
    surface: 'tui',
    say: (_kind, text) => messages.push(text),
    prefillInput() {},
    getContextUsage: () => ({
      used: 11_500,
      total: 100_000,
      source: 'provider',
      inputTokens: 8_000,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 500,
    }),
  });
  assert.equal(handled, true);
  assert.match(messages[0], /11,500 \/ 100,000/);
  assert.match(messages[0], /provider-reported/);
  assert.match(messages[0], /input\s+8,000/);
  assert.match(messages[0], /cache read\s+3,000/);
  assert.doesNotMatch(messages[0], /usage\s+~/, 'provider usage is not labeled as an estimate');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-registry-cost-'));
  const customLogPath = path.join(workspace, 'telemetry', 'usage.jsonl');
  const messages = [];
  try {
    await logLLMUsage(
      {
        runId: 'custom-cost-path',
        providerId: 'test-provider',
        model: 'unknown-model',
        inputTokens: 123,
        outputTokens: 7,
        durationMs: 10,
        success: true,
      },
      { logPath: customLogPath }
    );

    const handled = await runRegistryCommand('/cost', {
      agent: { config: { llmUsageLogPath: customLogPath } },
      runtime: undefined,
      sessionKey: 'test',
      workspace,
      surface: 'tui',
      say: (_kind, text) => messages.push(text),
      prefillInput() {},
    });
    assert.equal(handled, true);
    assert.match(
      messages[0],
      /123 in \/ 7 out/,
      '/cost reads the same custom log path used by the agent'
    );
    assert.doesNotMatch(
      messages[0],
      /No LLM usage recorded/,
      '/cost does not falsely report an empty workspace'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-registry-cost-empty-'));
  const customLogPath = path.join(workspace, 'telemetry', 'empty.jsonl');
  const messages = [];
  try {
    await runRegistryCommand('/cost', {
      agent: { config: { llmUsageLogPath: customLogPath } },
      runtime: undefined,
      sessionKey: 'test',
      workspace,
      surface: 'tui',
      say: (_kind, text) => messages.push(text),
      prefillInput() {},
    });
    assert.match(messages[0], new RegExp(customLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(messages[0], /\.moss\/llm-usage\.jsonl/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

{
  // /review with a PR number
  const match = findRegistryCommand('/review 42');
  assert.ok(match !== null, '/review is a known registry command');
  assert.equal(match.args, '42', 'PR number is captured in args');
}

{
  const match = findRegistryCommand('/notacommand');
  assert.equal(match, null, 'unknown command returns null');
}

{
  // Non-slash input is not a command
  const match = findRegistryCommand('hello world');
  assert.equal(match, null, 'plain text is not a command');
}

{
  // Custom commands can be registered by the user
  const customCmd = { name: '/deploy', description: 'deploy to production', run: async () => {} };
  const match = findRegistryCommand('/deploy staging', [customCmd]);
  assert.ok(match !== null, 'custom command is found');
  assert.equal(match.args, 'staging');
}

{
  // Built-in commands shadow custom commands with the same name
  const shadowCmd = { name: '/status', description: 'shadowed', run: async () => {} };
  const match = findRegistryCommand('/status', [shadowCmd]);
  assert.ok(match !== null);
  // Built-in wins (no way to verify internally, but it should not crash)
}

// ─── unknownSlashCommandLines — helpful error for typos ──────────────────────

{
  const lines = unknownSlashCommandLines('/modle');
  assert.ok(Array.isArray(lines) && lines.length >= 2, 'at least two lines in error message');
  assert.ok(
    lines[0].includes('/modle') || lines[0].includes('Unknown'),
    'first line names the unknown command'
  );
  assert.ok(
    lines.some((l) => l.includes('/help')),
    'error message points to /help'
  );
  assert.ok(
    lines.some((l) => l.includes('/')),
    'error message explains slash-command behavior'
  );
}

{
  // Suggestion when close match is available
  const lines = unknownSlashCommandLines('/modle', { suggestion: '/model' });
  assert.ok(
    lines.some((l) => l.includes('/model')),
    'suggestion is shown in the error message'
  );
}

{
  // Chinese locale support
  const lines = unknownSlashCommandLines('/modle', { locale: 'zh-CN' });
  assert.ok(
    lines.some((l) => /[一-龥]/.test(l)),
    'Chinese locale shows Chinese text'
  );
}

console.log('[PASS] Command registry');
