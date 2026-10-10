#!/usr/bin/env node
/**
 * Claude tool-name mapping and reading `.claude/` project files.
 * Folder trust decides whether those files load; this module does not ask.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeToolName,
  hookMatcherMatches,
  readClaudeMcpConfigs,
  readClaudeProjectHooks,
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

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-claude-'));
  const ws = path.join(root, 'ws');
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
}

console.log('[PASS] claude-compat');
