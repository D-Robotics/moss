#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySessionStore, MossAgent } from '../dist/index.js';

// Real SDK loop with a controlled provider; no network or package-manager execution.
for (const [message, expectedReminder] of [
  ['Read fixture.txt. Do not install dependencies. Only output valid JSON.', false],
  ['读取fixture.txt，不安装依赖。只输出一个有效JSON。', false],
  ['读取fixture.txt，不执行命令、不安装依赖、不连接设备。', false],
  ['Read fixture.txt. Do not run commands, do not install dependencies.', false],
  ['Read fixture.txt and install dependencies.', true],
  ['Do not install dependencies unless I confirm. Read fixture.txt.', true],
  ['Do not not install dependencies. Read fixture.txt.', true],
  ['不执行命令、不要不安装依赖。读取fixture.txt。', true],
]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-install-nudge-'));
  const observed = [];
  const respond = (options) => {
    observed.push(
      options.messages.some((entry) =>
        JSON.stringify(entry.content).includes('[System] The user asked to install dependencies')
      )
    );
    return observed.length === 1
      ? {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'read-one', name: 'read', input: {} }],
        }
      : { stopReason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] };
  };
  const provider = {
    id: 'controlled-install-nudge',
    displayName: 'Controlled',
    capabilities: { streaming: true },
    complete: async (options) => respond(options),
    stream: async (options, emit) => {
      const result = respond(options);
      for (const block of result.content)
        if (block.type === 'text') emit({ type: 'content_block_delta', text: block.text });
      return result;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    workspaceDir: root,
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    enableCompaction: false,
    maxAgentTurns: 3,
  });
  try {
    agent.tools.register({
      name: 'read',
      description: 'fixture reader',
      inputSchema: { type: 'object' },
      metadata: { sideEffectClass: 'readonly' },
      execute: async () => 'fixture contents',
    });
    await agent.chat('install-nudge-regression', message);
    assert.deepEqual(observed, [false, expectedReminder], message);
  } finally {
    await agent.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
console.log('[PASS] install-tools-nudge-agent');
