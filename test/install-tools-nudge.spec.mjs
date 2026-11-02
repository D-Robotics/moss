#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateInstallToolsNudge } from '../dist/core/loop/nudges/install-tools-nudge.js';

// No tools yet
{
  const r = evaluateInstallToolsNudge({
    userText: 'install the dependencies with npm install',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Install ask + tools without install exec → fire
{
  const r = evaluateInstallToolsNudge({
    userText: 'install the dependencies with npm install',
    toolCallsByName: { read_file: 1 },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'read_file', input: { path: 'package.json' } },
        ],
      },
    ],
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /npm|pnpm|yarn|install/i);
}

// Install exec already present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'i1',
          name: 'exec',
          input: { command: 'npm install' },
        },
      ],
    },
  ];
  const r = evaluateInstallToolsNudge({
    userText: 'install deps',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateInstallToolsNudge({
    userText: 'pnpm install please',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

// Explicit no-install constraints must never become an install instruction.
for (const userText of [
  '创建 slug.mjs，不要安装依赖、访问网络或修改 README。',
  '请修复问题，禁止运行 npm install。',
  'Implement the change; do not install dependencies.',
  "Inspect the code; don't run npm install.",
]) {
  const result = evaluateInstallToolsNudge({
    userText,
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(result.fire, false, userText);
}

// A negative constraint must not hide a separate affirmative installation request.
for (const userText of [
  '不要运行 npm install，而是执行 pnpm install。',
  "Don't run npm install; install the dependencies with pnpm install.",
]) {
  const result = evaluateInstallToolsNudge({
    userText,
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(result.fire, true, userText);
}

console.log('[PASS] install-tools-nudge');
