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

import { messageRequestsTaskContract } from '../dist/cli/task-flow.js';
import {
  HIDDEN_USER_QUESTION_MESSAGE,
  toolVisibleForRun,
} from '../dist/core/agent/session-tool-offer.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { DEVICE_TOOL_NAMES } from '../dist/device/device-tool-offer.js';
import { configureDefaultDeviceTarget } from '../dist/device/device-target.js';
import { deviceTools } from '../dist/tools/device-tools.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import { readFileTool } from '../dist/tools/file-tools.js';
import { taskTools } from '../dist/tools/task-tools.js';
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
  for (const tool of [readFileTool, recordEvidenceTool, ...taskTools, ...deviceTools]) {
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
  assert.equal(toolVisibleForRun('task_acceptance', { taskFlow: false }), false);
  assert.equal(toolVisibleForRun('task_plan_update', { taskFlow: false }), false);
  assert.equal(toolVisibleForRun('record_failure', { taskFlow: false }), false);
  assert.equal(toolVisibleForRun('record_repair', { taskFlow: false }), false);
  assert.equal(toolVisibleForRun('record_evidence', {}), true);
  assert.equal(toolVisibleForRun('task_acceptance', {}), true);
  assert.equal(toolVisibleForRun('record_failure', { taskFlow: true }), true);
  assert.equal(toolVisibleForRun('task_define', { taskFlow: true }), true);
  assert.equal(toolVisibleForRun('task_acceptance', {}), true);
  assert.equal(toolVisibleForRun('search_code', { deviceConfigured: false }), true);
  assert.equal(toolVisibleForRun('ask_user_question', {}), true);
  assert.equal(
    toolVisibleForRun('ask_user_question', { userQuestions: false, requiresUserQuestion: true }),
    false
  );
  assert.equal(
    toolVisibleForRun('ask_user_question', { userQuestions: true, requiresUserQuestion: true }),
    true
  );
  assert.equal(
    toolVisibleForRun('ask_user_question', { userQuestions: false }),
    true,
    'the tool name alone does not hide a question tool'
  );
  assert.equal(toolVisibleForRun('task_define', { userQuestions: false }), true);
});

test('headless chat omits ask_user_question and keeps the task ledger', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ask-offer-'));
  const seen = [];
  const agent = makeAgent(capturingProvider(seen), ws);
  agent.tools.register({
    name: 'ask_user_question',
    description: 'Ask the user.',
    metadata: { requiresUserQuestion: true },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'asked';
    },
  });
  try {
    await agent.chat('qa-headless', 'Which pin is the camera clock?');
    const names = seen[0]?.tools ?? [];
    assert.ok(!names.includes('ask_user_question'));
    assert.ok(names.includes('task_define'));
    assert.ok(names.includes('record_evidence'));

    seen.length = 0;
    agent.setUserQuestionAsker(async () => 'the camera clock');
    await agent.chat('qa-asked', 'Which pin is the camera clock?');
    const asked = seen[0]?.tools ?? [];
    assert.ok(asked.includes('ask_user_question'));
    assert.ok(asked.includes('task_define'));
  } finally {
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('enrichToolContext asker keeps the question tool, including in oneshot', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-hook-asker-'));
  const seen = [];
  const questionTool = {
    name: 'ask_user_question',
    description: 'Ask the user.',
    metadata: { requiresUserQuestion: true },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'asked';
    },
  };
  const agent = new MossAgent({
    llmProvider: capturingProvider(seen),
    sessionStore: new InMemorySessionStore(),
    model: 'offer-capture',
    workspaceDir: ws,
    baseSystemPrompt: 'Answer the question.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 2,
    hooks: {
      enrichToolContext(base) {
        return { ...base, askUserQuestion: async () => 'from the host' };
      },
    },
  });
  agent.tools.register(questionTool);
  agent.tools.register(recordEvidenceTool);
  for (const tool of taskTools) agent.tools.register(tool);
  const sink = { write() {} };
  try {
    await agent.chat('hook-asker', 'Which pin is the camera clock?');
    assert.ok((seen[0]?.tools ?? []).includes('ask_user_question'));
    assert.ok((seen[0]?.tools ?? []).includes('task_define'));

    seen.length = 0;
    await runOneShot(agent, 'Look up the camera pinmux in the board docs.', {
      outputFormat: 'json',
      stdout: sink,
      cwd: ws,
      sessionKey: 'hook-oneshot',
    });
    assert.ok((seen[0]?.tools ?? []).includes('ask_user_question'));
    assert.ok((seen[0]?.tools ?? []).includes('task_define'));
  } finally {
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
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

test('plain Q&A does not receive a task-phase prompt', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-qa-phase-'));
  const seen = [];
  const agent = makeAgent(
    {
      id: 'offer-capture',
      displayName: 'offer',
      capabilities: { streaming: false },
      async complete(options) {
        seen.push({
          systemPrompt: options.systemPrompt ?? '',
          messages: options.messages ?? [],
        });
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
    ws
  );
  agent.config.dynamicPromptLayers = [
    '## Docs\nSearch first, open at most 2 pages.',
    '[task-phase:planning]\nGoal: flash the board\n1. task_define',
  ];
  try {
    await agent.chat('qa', 'What is the camera pinout?', {
      taskFlow: false,
      extraContext: '[task-phase:executing]\nContinue the goal and call task_define.',
    });
    const prompt = seen[0]?.systemPrompt ?? '';
    assert.match(prompt, /Search first, open at most 2 pages/);
    assert.doesNotMatch(prompt, /\[task-phase:/);
    assert.doesNotMatch(prompt, /flash the board/);
    const transcript = JSON.stringify(seen[0]?.messages ?? []);
    assert.doesNotMatch(transcript, /\[task-phase:/);
    assert.doesNotMatch(transcript, /Continue the goal/);
    assert.match(transcript, /camera pinout/);
  } finally {
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

const TASK_LEDGER = [
  'task_define',
  'task_acceptance',
  'task_plan_update',
  'record_evidence',
  'record_failure',
  'record_repair',
];

test('interactive /goal and /task offer the task ledger on the first model call', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-ledger-'));
  const savedHost = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  configureDefaultDeviceTarget(null);
  try {
    for (const message of ['/goal ship the parser', '/task inspect the board']) {
      const seen = [];
      const agent = makeAgent(capturingProvider(seen), ws);
      const taskFlow = messageRequestsTaskContract(message);
      assert.equal(taskFlow, true, message);
      try {
        await agent.chat(`ledger-${message}`, message, { taskFlow });
        assert.equal(seen.length >= 1, true, `${message} reaches the model`);
        const names = seen[0]?.tools ?? [];
        for (const name of TASK_LEDGER) {
          assert.ok(names.includes(name), `${message} first call includes ${name}`);
        }
      } finally {
        await agent.close();
      }
    }
  } finally {
    configureDefaultDeviceTarget(null);
    if (savedHost === undefined) delete process.env.MOSS_DEVICE_HOST;
    else process.env.MOSS_DEVICE_HOST = savedHost;
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('task tools stay offered once a session has shown them', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sticky-ledger-'));
  const savedHost = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  configureDefaultDeviceTarget(null);
  const seen = [];
  const agent = makeAgent(capturingProvider(seen), ws);
  try {
    await agent.chat('sticky', 'Look up the camera pinout.', { taskFlow: false });
    assert.ok(!(seen[0]?.tools ?? []).includes('task_define'));
    seen.length = 0;
    await agent.chat('sticky', '/goal ship it', { taskFlow: true });
    assert.ok((seen[0]?.tools ?? []).includes('task_define'));
    assert.ok((seen[0]?.tools ?? []).includes('record_evidence'));
    seen.length = 0;
    await agent.chat('sticky', 'what is the pinout?', { taskFlow: false });
    const names = seen[0]?.tools ?? [];
    assert.ok(names.includes('task_define'), 'a later Q&A turn keeps task_define');
    assert.ok(names.includes('record_evidence'), 'a later Q&A turn keeps record_evidence');
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

function questionTool() {
  return {
    name: 'ask_user_question',
    description: 'Ask the user.',
    metadata: { requiresUserQuestion: true },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'asked';
    },
  };
}

test('moss -p request body excludes ask_user_question and keeps task tools', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-p-ask-body-'));
  const seen = [];
  const agent = makeAgent(capturingProvider(seen), ws);
  agent.tools.register(questionTool());
  const sink = { write() {} };
  try {
    await runOneShot(agent, 'Look up the camera pinmux in the board docs.', {
      outputFormat: 'json',
      stdout: sink,
      cwd: ws,
      sessionKey: 'headless-p-body',
    });
    const names = seen[0]?.tools ?? [];
    assert.equal(names.includes('ask_user_question'), false);
    assert.ok(names.includes('task_define'));
    assert.ok(names.includes('record_evidence'));
    assert.ok(names.includes('read_file'));
  } finally {
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('calling the hidden question tool returns the no-user guidance', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-hidden-ask-'));
  const toolEnds = [];
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('hidden-ask', 'Hidden', [
      {
        toolCalls: [
          {
            name: 'ask_user_question',
            input: { questions: [{ question: 'Which pin?' }] },
          },
        ],
      },
      { text: 'Assuming GPIO 3.' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'hidden-ask',
    workspaceDir: ws,
    baseSystemPrompt: 'Answer the question.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
  });
  agent.tools.register(questionTool());
  const sink = { write() {} };
  try {
    await runOneShot(agent, 'Look up the camera pinmux in the board docs.', {
      outputFormat: 'json',
      stdout: sink,
      cwd: ws,
      sessionKey: 'hidden-ask-call',
      onAgentEvent(event) {
        if (event.type === 'tool_end') toolEnds.push(event);
      },
    });
    assert.equal(toolEnds.length, 1);
    assert.equal(toolEnds[0].toolName, 'ask_user_question');
    assert.equal(toolEnds[0].result, HIDDEN_USER_QUESTION_MESSAGE);
    assert.match(toolEnds[0].result, /no user is available/i);
    assert.match(toolEnds[0].result, /best judgment/);
    assert.match(toolEnds[0].result, /assumptions/);
    assert.equal(toolEnds[0].result.includes('Unknown tool'), false);
  } finally {
    await agent.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('a throwing hook hides the question tool; a runId hook keeps it and runs once', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-hook-runid-'));
  const sink = { write() {} };
  try {
    const thrown = [];
    const throwing = new MossAgent({
      llmProvider: capturingProvider(thrown),
      sessionStore: new InMemorySessionStore(),
      model: 'offer-capture',
      workspaceDir: ws,
      baseSystemPrompt: 'Answer the question.',
      domainPrompt: false,
      includeAgentBehaviorPrompt: false,
      includeLanguagePolicyPrompt: false,
      enableSteering: false,
      enableFollowUpGuard: false,
      maxAgentTurns: 2,
      hooks: {
        enrichToolContext() {
          throw new Error('host asker probe failed');
        },
      },
    });
    throwing.tools.register(questionTool());
    throwing.tools.register(recordEvidenceTool);
    await throwing.chat('throw-hook', 'Which pin is the camera clock?');
    assert.equal((thrown[0]?.tools ?? []).includes('ask_user_question'), false);
    await throwing.close();

    let calls = 0;
    const seen = [];
    const runIdHook = new MossAgent({
      llmProvider: createMockTranscriptProvider('run-id-ask', 'RunId', [
        { toolCalls: [{ name: 'read_file', input: { path: 'missing.txt' } }] },
        { text: 'done' },
      ]),
      sessionStore: new InMemorySessionStore(),
      model: 'run-id-ask',
      workspaceDir: ws,
      baseSystemPrompt: 'Answer the question.',
      domainPrompt: false,
      includeAgentBehaviorPrompt: false,
      includeLanguagePolicyPrompt: false,
      enableSteering: false,
      enableFollowUpGuard: false,
      maxAgentTurns: 4,
      hooks: {
        enrichToolContext(base) {
          calls += 1;
          if (!base.runId) return base;
          seen.push(base.runId);
          return { ...base, askUserQuestion: async () => 'from the host' };
        },
      },
    });
    runIdHook.tools.register(questionTool());
    runIdHook.tools.register(readFileTool);
    const offered = [];
    const original = runIdHook.config.llmProvider.complete.bind(runIdHook.config.llmProvider);
    runIdHook.config.llmProvider.complete = async (options) => {
      offered.push((options.tools ?? []).map((tool) => tool.name));
      return original(options);
    };
    await runOneShot(runIdHook, 'Read missing.txt and say what is in it.', {
      outputFormat: 'json',
      stdout: sink,
      cwd: ws,
      sessionKey: 'run-id-hook',
    });
    assert.equal(calls, 1);
    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0], 'string');
    assert.ok(seen[0].length > 0);
    assert.ok(offered[0]?.includes('ask_user_question'));
    assert.ok(offered[0]?.includes('read_file'));
    await runIdHook.close();
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
