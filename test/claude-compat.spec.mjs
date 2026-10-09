#!/usr/bin/env node
/**
 * Claude tool-name mapping and the one-time opt-in for `.claude/` config.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeOptInQuestion,
  claudeToolName,
  hookMatcherMatches,
  readClaudeMcpConfigs,
  readClaudeProjectHooks,
  resolveClaudeCompatOptIn,
} from '../dist/cli/claude-compat.js';

assert.equal(claudeToolName('exec'), 'Bash');
assert.equal(claudeToolName('edit_file'), 'Edit');
assert.equal(claudeToolName('write_file'), 'Write');
assert.equal(claudeToolName('read_file'), 'Read');
assert.equal(hookMatcherMatches('Bash', 'exec', true), true);
assert.equal(hookMatcherMatches('Edit|Write', 'write_file', true), true);
assert.equal(hookMatcherMatches('Edit, Write', 'edit_file', true), true);
assert.equal(hookMatcherMatches('Bash,Edit', 'exec', true), true);
assert.equal(hookMatcherMatches('Bash,Edit', 'search_code', true), false);
assert.equal(hookMatcherMatches('*', 'read_file', true), true);
assert.equal(hookMatcherMatches('', 'exec', true), true);
assert.equal(hookMatcherMatches('^Notebook', 'edit_file', true), true);
assert.equal(hookMatcherMatches('Grep', 'search_code', true), true);
assert.equal(hookMatcherMatches('Glob', 'search_files', true), true);
assert.equal(hookMatcherMatches('Bash', 'exec', false), false, 'moss matchers stay literal');
assert.equal(hookMatcherMatches('Read', 'read_file', true), true);

assert.match(claudeOptInQuestion(false), /Claude config/);
assert.match(claudeOptInQuestion(true), /Claude 配置/);

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-claude-'));
  const ws = path.join(root, 'ws');
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo hi', timeout: 2 }],
          },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt' }] }],
      },
    })
  );
  fs.writeFileSync(
    path.join(ws, '.mcp.json'),
    JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp', args: ['--stdio'] } } })
  );
  const hooks = readClaudeProjectHooks(ws);
  assert.equal(hooks.PreToolUse[0].format, 'claude');
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(hooks.PreToolUse[0].command, 'echo hi');
  assert.equal(hooks.PreToolUse[0].timeoutMs, 2000);
  assert.equal(hooks.UserPromptSubmit[0].command, 'echo prompt');
  const servers = readClaudeMcpConfigs(ws, {});
  assert.equal(servers[0].name, 'docs');
  assert.equal(servers[0].transport, 'stdio');
  assert.equal(servers[0].command, 'docs-mcp');

  let asks = 0;
  const first = await resolveClaudeCompatOptIn({
    workspaceDir: ws,
    configDir,
    interactive: true,
    zh: false,
    ask: async (question) => {
      asks += 1;
      assert.match(question, /\[y\/N\]/);
      return true;
    },
  });
  assert.equal(first, true);
  assert.equal(asks, 1);
  const second = await resolveClaudeCompatOptIn({
    workspaceDir: ws,
    configDir,
    interactive: true,
    ask: async () => {
      asks += 1;
      return false;
    },
  });
  assert.equal(second, true, 'the yes is remembered');
  assert.equal(asks, 1);

  const other = fs.mkdtempSync(path.join(root, 'other-'));
  fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(other, '.claude', 'settings.json'), '{"hooks":{}}');
  const headless = await resolveClaudeCompatOptIn({
    workspaceDir: other,
    configDir,
    interactive: false,
    ask: async () => {
      throw new Error('headless must not ask');
    },
  });
  assert.equal(headless, false);
  const later = await resolveClaudeCompatOptIn({
    workspaceDir: other,
    configDir,
    interactive: true,
    ask: async () => true,
  });
  assert.equal(later, true, 'a headless skip does not remember a no');
}

{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-claude-empty-'));
  const opted = await resolveClaudeCompatOptIn({
    workspaceDir: empty,
    configDir: path.join(empty, 'cfg'),
    interactive: true,
    ask: async () => {
      throw new Error('no claude config, no prompt');
    },
  });
  assert.equal(opted, false);
}

console.log('[PASS] claude-compat');
