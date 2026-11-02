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
  createFileBasedTool,
  loadFileBasedToolDefinitions,
  loadFileBasedTools,
} from '../dist/tools/file-based-tools.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fb-tools-'));
try {
  const toolsDir = path.join(ws, '.moss', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  // ─── 1. loadFileBasedToolDefinitions reads .tool.json files ──────────────

  fs.writeFileSync(
    path.join(toolsDir, 'echo.tool.json'),
    JSON.stringify({
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
    })
  );

  // A malformed file is skipped, not fatal.
  fs.writeFileSync(path.join(toolsDir, 'broken.tool.json'), '{ not valid json');

  // A file missing required fields is skipped.
  fs.writeFileSync(
    path.join(toolsDir, 'incomplete.tool.json'),
    JSON.stringify({
      name: 'incomplete',
      // missing description, command, inputSchema
    })
  );

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
    { workspaceDir: ws, sessionKey: 'test', abortSignal: new AbortController().signal }
  );
  assert.ok(
    result.includes('hello from test'),
    'tool returns the command stdout (which echoed the stdin JSON)'
  );

  // ─── 3. dangerous command is blocked ─────────────────────────────────────

  fs.writeFileSync(
    path.join(toolsDir, 'danger.tool.json'),
    JSON.stringify({
      name: 'dangerous_tool',
      description: 'A tool with a dangerous command.',
      command: 'rm -rf /',
      inputSchema: { type: 'object', properties: {} },
    })
  );
  const toolsWithDanger = loadFileBasedTools(ws);
  const dangerTool = toolsWithDanger.find((t) => t.name === 'dangerous_tool');
  assert.ok(dangerTool, 'dangerous tool loaded');
  const dangerResult = await dangerTool.execute(
    {},
    { workspaceDir: ws, sessionKey: 'test', abortSignal: new AbortController().signal }
  );
  assert.ok(
    dangerResult.startsWith('Command blocked:'),
    'dangerous command is blocked by isCommandDangerous'
  );

  // ─── 4. empty workspace → no tools ───────────────────────────────────────

  const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fb-empty-'));
  try {
    assert.equal(
      loadFileBasedTools(emptyWs).length,
      0,
      'empty workspace loads no file-based tools'
    );
  } finally {
    fs.rmSync(emptyWs, { recursive: true, force: true });
  }

  // A real child reports only whether each synthetic environment variable exists.
  const probe = path.join(ws, 'env-probe.cjs');
  fs.writeFileSync(
    probe,
    `process.stdout.write(JSON.stringify({
      device: Boolean(process.env.MOSS_DEVICE_HOST),
      deviceExtension: Boolean(process.env.MOSS_DEVICE_SYNTHETIC),
      benchmarkKey: Boolean(process.env.MOSS_BENCH_API_KEY),
      apiKey: Boolean(process.env.OPENAI_API_KEY),
      accessKey: Boolean(process.env.AWS_ACCESS_KEY_ID),
      ordinary: Boolean(process.env.MOSS_SYNTHETIC_ORDINARY),
      path: Boolean(process.env.PATH || process.env.Path),
      auth: Boolean(process.env.AUTH)
    }));
    process.exit(0);`
  );
  const syntheticNames = [
    'MOSS_DEVICE_HOST',
    'MOSS_DEVICE_SYNTHETIC',
    'MOSS_BENCH_API_KEY',
    'OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'MOSS_SYNTHETIC_ORDINARY',
    'AUTH',
    'NODE_OPTIONS',
  ];
  const previous = new Map(syntheticNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of syntheticNames) process.env[name] = 'synthetic';
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(probe)}`;
    const probeTool = createFileBasedTool({
      name: 'env_probe',
      description: 'Report synthetic environment presence.',
      command: process.execPath,
      inputSchema: { type: 'object', properties: {} },
    });
    const result = JSON.parse(
      await probeTool.execute({}, { workspaceDir: ws, abortSignal: new AbortController().signal })
    );
    const { auth, ...visible } = result;
    console.error(`custom AUTH visible to file-tool child: ${auth}`);
    assert.equal(typeof auth, 'boolean');
    assert.deepEqual(visible, {
      device: false,
      deviceExtension: false,
      benchmarkKey: false,
      apiKey: false,
      accessKey: false,
      ordinary: true,
      path: true,
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error('file-based-tools: load + create + execute + dangerous-block + empty ✓');
