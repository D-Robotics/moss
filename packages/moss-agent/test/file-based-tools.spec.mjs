#!/usr/bin/env node
/**
 * File-based custom tools — `.moss/tools/<name>.tool.json`.
 * Tests the load → create → execute lifecycle from the user's perspective:
 * define a tool via JSON, moss loads it, the LLM calls it, the command runs
 * with the input on stdin, and the output is returned.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadFileBasedToolDefinitions,
  createFileBasedTool,
  loadFileBasedTools,
} from '../dist/tools/file-based-tools.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fb-tools-'));
try {
  const toolsDir = path.join(ws, '.moss', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  // ─── 1. loadFileBasedToolDefinitions reads .tool.json files ──────────────

  fs.writeFileSync(path.join(toolsDir, 'echo.tool.json'), JSON.stringify({
    name: 'echo_input',
    description: 'Echo the JSON input back via a shell command.',
    command: 'cat',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    sideEffect: 'readonly',
    planMode: 'allow',
  }));

  // A malformed file is skipped, not fatal.
  fs.writeFileSync(path.join(toolsDir, 'broken.tool.json'), '{ not valid json');

  // A file missing required fields is skipped.
  fs.writeFileSync(path.join(toolsDir, 'incomplete.tool.json'), JSON.stringify({
    name: 'incomplete',
    // missing description, command, inputSchema
  }));

  const defs = loadFileBasedToolDefinitions(ws);
  assert.equal(defs.length, 1, 'only the valid definition loads (broken + incomplete skipped)');
  assert.equal(defs[0].name, 'echo_input');

  // ─── 2. createFileBasedTool produces a working Tool ──────────────────────

  const tools = loadFileBasedTools(ws);
  assert.equal(tools.length, 1, 'one tool loaded');
  const tool = tools[0];
  assert.equal(tool.name, 'echo_input');
  assert.equal(tool.metadata.sideEffectClass, 'readonly');
  assert.equal(tool.metadata.planMode, 'allow');

  // Execute: `cat` reads stdin (the JSON input) and echoes it back.
  const result = await tool.execute(
    { message: 'hello from test' },
    { workspaceDir: ws, sessionKey: 'test', abortSignal: new AbortController().signal },
  );
  assert.ok(result.includes('hello from test'), 'tool returns the command stdout (which echoed the stdin JSON)');

  // ─── 3. dangerous command is blocked ─────────────────────────────────────

  fs.writeFileSync(path.join(toolsDir, 'danger.tool.json'), JSON.stringify({
    name: 'dangerous_tool',
    description: 'A tool with a dangerous command.',
    command: 'rm -rf /',
    inputSchema: { type: 'object', properties: {} },
  }));
  const toolsWithDanger = loadFileBasedTools(ws);
  const dangerTool = toolsWithDanger.find((t) => t.name === 'dangerous_tool');
  assert.ok(dangerTool, 'dangerous tool loaded');
  const dangerResult = await dangerTool.execute(
    {},
    { workspaceDir: ws, sessionKey: 'test', abortSignal: new AbortController().signal },
  );
  assert.ok(dangerResult.startsWith('Command blocked:'), 'dangerous command is blocked by isCommandDangerous');

  // ─── 4. empty workspace → no tools ───────────────────────────────────────

  const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fb-empty-'));
  try {
    assert.equal(loadFileBasedTools(emptyWs).length, 0, 'empty workspace loads no file-based tools');
  } finally {
    fs.rmSync(emptyWs, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error('file-based-tools: load + create + execute + dangerous-block + empty ✓');
