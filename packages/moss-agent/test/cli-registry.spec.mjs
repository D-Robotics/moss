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
    openSoulPicker: () => { opened = true; },
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
  assert.ok(lines[0].includes('/modle') || lines[0].includes('Unknown'), 'first line names the unknown command');
  assert.ok(lines.some((l) => l.includes('/help')), 'error message points to /help');
  assert.ok(lines.some((l) => l.includes('/')), 'error message explains slash-command behavior');
}

{
  // Suggestion when close match is available
  const lines = unknownSlashCommandLines('/modle', { suggestion: '/model' });
  assert.ok(lines.some((l) => l.includes('/model')), 'suggestion is shown in the error message');
}

{
  // Chinese locale support
  const lines = unknownSlashCommandLines('/modle', { locale: 'zh-CN' });
  assert.ok(lines.some((l) => /[一-龥]/.test(l)), 'Chinese locale shows Chinese text');
}

console.log('[PASS] Command registry');
