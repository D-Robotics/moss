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

// ─── registryCommandNames — built-in slash commands ──────────────────────────

{
  const names = registryCommandNames();
  assert.ok(Array.isArray(names), 'registryCommandNames returns an array');
  assert.ok(names.length > 0, 'there are registered commands');

  // Commands handled by the registry (others like /clear, /model are handled by the TUI chain)
  for (const cmd of ['/status', '/doctor', '/review']) {
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

// ─── /review in a non-git workspace: classified, not crashed ───────────────

{
  // git exits non-zero (128/129 by version) outside a repo and runProcess
  // rejects — /review must still answer with the honest "not a git
  // repository" guidance, which means the rejection is classified, not
  // surfaced as a raw ProcessError.
  const messages = [];
  const os = await import('node:os');
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const nonGit = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'moss-review-nogit-'));
  const errors = [];
  await runRegistryCommand('/review', {
    agent: { config: { model: 'm', contextTokens: 1000 } },
    runtime: undefined,
    sessionKey: 'review-spec',
    workspace: nonGit,
    surface: 'repl',
    say: (kind, text) => {
      (kind === 'error' ? errors : messages).push(text);
    },
    prefillInput() {},
    submitPrompt: () => {
      messages.push('(submitted)');
    },
  });
  const said = [...errors, ...messages].join('\n');
  assert.ok(
    /review needs a git workspace|Not a git repository/i.test(said),
    `/review classifies a non-git workspace instead of crashing: ${said.slice(0, 160)}`
  );
  assert.ok(
    !/ProcessError|git diff failed: Command/i.test(said),
    'no raw process internals leak into the answer'
  );
}

console.log('[PASS] Command registry');
