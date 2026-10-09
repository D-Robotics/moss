#!/usr/bin/env node
/**
 * Device tools stay registered for the SDK and `/device add`, but the model
 * does not see them until a target exists. Interactive chat can hide the task
 * ledger with taskFlow: false. Headless `moss -p` leaves taskFlow unset, so
 * task_define and record_evidence stay available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { toolVisibleForRun } from '../dist/core/agent/session-tool-offer.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { DEVICE_TOOL_NAMES } from '../dist/device/device-tool-offer.js';
import { configureDefaultDeviceTarget } from '../dist/device/device-target.js';
import { deviceTools } from '../dist/tools/device-tools.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import { readFileTool } from '../dist/tools/file-tools.js';
import { taskDefineTool } from '../dist/tools/task-tools.js';
import { runOneShot } from '../dist/cli/oneshot.js';

const DEVICE_NAMES = new Set(DEVICE_TOOL_NAMES);

function capturingProvider(seen) {
  return {
    id: 'offer-capture',
    displayName: 'offer',
    capabilities: { streaming: false },
    async complete(options) {
      seen.push({
        tools: (options.tools ?? []).map((tool) => tool.name),
        systemPrompt: options.systemPrompt ?? '',
      });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

function makeAgent(provider, workspaceDir) {
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'offer-capture',
    workspaceDir,
    baseSystemPrompt: 'Answer the question.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 2,
  });
  for (const tool of [readFileTool, taskDefineTool, recordEvidenceTool, ...deviceTools]) {
    agent.tools.register(tool);
  }
  return agent;
}

test('device tool names match the registered device tools', () => {
  assert.deepEqual([...DEVICE_TOOL_NAMES].sort(), deviceTools.map((tool) => tool.name).sort());
});

test('tool visibility: no device hides device tools; plain Q&A hides the ledger', () => {
  for (const name of DEVICE_TOOL_NAMES) {
    assert.equal(toolVisibleForRun(name, { deviceConfigured: false }), false, name);
    assert.equal(toolVisibleForRun(name, { deviceConfigured: true, taskFlow: false }), true, name);
  }
  assert.equal(toolVisibleForRun('read_file', { deviceConfigured: false, taskFlow: false }), true);
  assert.equal(toolVisibleForRun('record_evidence', { taskFlow: false }), false);
  assert.equal(toolVisibleForRun('task_define', { taskFlow: false }), false);
  assert.equal(toolVisibleForRun('record_evidence', {}), true);
  assert.equal(toolVisibleForRun('task_define', { taskFlow: true }), true);
  assert.equal(toolVisibleForRun('search_code', { deviceConfigured: false }), true);
});

test('the model tool list omits device and ledger tools for plain Q&A', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tool-offer-'));
  const savedHost = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  configureDefaultDeviceTarget(null);
  const seen = [];
  const agent = makeAgent(capturingProvider(seen), ws);
  try {
    await agent.chat('qa', 'Look up the camera pinout.', { taskFlow: false });
    const names = seen[0]?.tools ?? [];
    assert.ok(names.includes('read_file'));
    assert.ok(!names.some((name) => DEVICE_NAMES.has(name)));
    assert.ok(!names.includes('record_evidence'));
    assert.ok(!names.includes('task_define'));

    seen.length = 0;
    configureDefaultDeviceTarget({
      deviceId: 'spec-board',
      kind: 'linux',
      host: '10.0.0.8',
      user: 'root',
    });
    await agent.chat('with-device', 'Probe the board.', { taskFlow: true });
    const withDevice = seen[0]?.tools ?? [];
    assert.ok(withDevice.includes('device_info'));
    assert.ok(withDevice.includes('record_evidence'));
    assert.ok(withDevice.includes('task_define'));
  } finally {
    configureDefaultDeviceTarget(null);
    if (savedHost === undefined) delete process.env.MOSS_DEVICE_HOST;
    else process.env.MOSS_DEVICE_HOST = savedHost;
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('headless moss -p still exposes task_define and record_evidence', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-oneshot-qa-'));
  const savedHost = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  configureDefaultDeviceTarget(null);
  const seen = [];
  const agent = makeAgent(capturingProvider(seen), ws);
  try {
    await runOneShot(agent, 'Read src/index.ts and explain the exports.', {
      sessionKey: 'headless-qa',
      outputFormat: 'json',
      headless: true,
      cwd: ws,
      stdout: { write() {} },
    });
    const names = seen[0]?.tools ?? [];
    assert.ok(names.includes('read_file'), 'workspace tools stay available');
    assert.ok(names.includes('task_define'), 'moss -p keeps task_define');
    assert.ok(names.includes('record_evidence'), 'moss -p keeps record_evidence');
    assert.ok(!names.some((name) => DEVICE_NAMES.has(name)));
    assert.doesNotMatch(seen[0]?.systemPrompt ?? '', /record device evidence/);
  } finally {
    configureDefaultDeviceTarget(null);
    if (savedHost === undefined) delete process.env.MOSS_DEVICE_HOST;
    else process.env.MOSS_DEVICE_HOST = savedHost;
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});
