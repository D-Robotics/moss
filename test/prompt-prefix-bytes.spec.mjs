#!/usr/bin/env node
/**
 * Two consecutive turns must send a byte-identical cached prefix: stable
 * system text plus tool schemas. Volatile layers ride the user message on
 * the OpenAI wire, after tools.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { buildMcpStableIndex } from '../dist/core/mcp/registry.js';
import {
  dynamicTurnContextBlock,
  openAiChatMessages,
} from '../dist/provider/pi-ai-http-transport.js';
import { countTokens } from '../scripts/prompt-token-report.mjs';

function capturingProvider(captured) {
  const respond = () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  return {
    id: 'prefix-bytes',
    displayName: 'prefix-bytes',
    capabilities: { streaming: true },
    async complete(opts) {
      captured.push(opts);
      return respond();
    },
    async stream(opts, onEvent) {
      captured.push(opts);
      onEvent?.({ type: 'message_start' });
      return respond();
    },
  };
}

function toolPayload(request) {
  return JSON.stringify(
    (request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? tool.parameters,
    }))
  );
}

test('dynamic layers do not change the stable system prompt or tool prefix', async () => {
  const captured = [];
  const agent = new MossAgent({
    llmProvider: capturingProvider(captured),
    sessionStore: new InMemorySessionStore(),
    model: 'prefix-bytes',
    baseSystemPrompt: 'You are Moss. Stable persona.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 4,
    extraPromptLayers: ['stable project instructions'],
    dynamicPromptLayers: ['## Environment\ngit: clean'],
  });
  agent.tools.register({
    name: 'probe_b',
    description: 'Probe B. Do not invent files.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Optional hint' } },
    },
    async execute() {
      return 'b';
    },
  });
  agent.tools.register({
    name: 'probe_a',
    description: 'Probe A.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'a';
    },
  });

  const sessionKey = 'prefix-bytes';
  for await (const event of agent.streamChat(sessionKey, 'first question')) {
    void event;
  }
  agent.config.dynamicPromptLayers = ['## Environment\ngit: dirty'];
  for await (const event of agent.streamChat(sessionKey, 'second question')) {
    void event;
  }

  assert.equal(captured.length, 2);
  assert.equal(captured[0].systemPromptParts.stable, captured[1].systemPromptParts.stable);
  assert.equal(captured[0].systemPromptParts.stable.includes('git:'), false);
  assert.notEqual(captured[0].systemPrompt, captured[1].systemPrompt);
  assert.equal(toolPayload(captured[0]), toolPayload(captured[1]));
  assert.deepEqual(
    captured[0].tools.map((tool) => tool.name),
    ['probe_a', 'probe_b'],
    'reversed registration still sorts by UTF-16 name'
  );

  const wire = [0, 1].map((index) =>
    openAiChatMessages({
      systemPrompt: captured[index].systemPrompt,
      systemPromptParts: captured[index].systemPromptParts,
      messages: [{ role: 'user', content: index === 0 ? 'first question' : 'second question' }],
    })
  );
  assert.equal(wire[0][0].role, 'system');
  assert.equal(wire[0][0].content, captured[0].systemPromptParts.stable);
  assert.equal(wire[0][0].content, wire[1][0].content);
  assert.equal(String(wire[0][0].content).includes('git:'), false);
  assert.match(String(wire[0].find((message) => message.role === 'user').content), /git: clean/);
  assert.match(String(wire[1].find((message) => message.role === 'user').content), /git: dirty/);
  assert.equal(captured[0].systemPrompt.includes('git: clean'), true);

  const index = buildMcpStableIndex(['rdk-docs', 'rdk-docs', ' other ']);
  assert.match(index, /## MCP Tool Servers/);
  assert.match(index, /mcp__rdk-docs__search/);
  assert.match(index, /mcp__other__search/);
  assert.doesNotMatch(index, /\d+ tool/);
  assert.equal(buildMcpStableIndex(['  ']), '');
});

function endTurnProvider(captured) {
  const respond = () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  return {
    id: 'prefix-bytes',
    displayName: 'prefix-bytes',
    capabilities: { streaming: true },
    async complete(opts) {
      captured.push(opts);
      return respond();
    },
    async stream(opts, onEvent) {
      captured.push(opts);
      onEvent?.({ type: 'message_start' });
      return respond();
    },
  };
}

function normalizeForWire(messages) {
  return (messages ?? []).map((message) => {
    if (message.role === 'assistant' && typeof message.content === 'string') {
      return { role: 'assistant', content: [{ type: 'text', text: message.content }] };
    }
    return message;
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

function wireOf(request) {
  return openAiChatMessages({
    systemPrompt: request.systemPrompt,
    systemPromptParts: request.systemPromptParts,
    messages: normalizeForWire(request.messages),
  });
}

function stripBlock(messages, block) {
  return normalizeForWire(messages).map((message) => {
    if (typeof message.content === 'string') {
      return { ...message, content: message.content.split(`\n\n${block}`).join('') };
    }
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (!part || part.type !== 'text' || typeof part.text !== 'string') return part;
        return { ...part, text: part.text.split(`\n\n${block}`).join('') };
      }),
    };
  });
}

/** Pre-fix wire: dynamic suffix re-attached to the latest user message every request. */
function legacyWire(request) {
  const dynamic = String(request.systemPromptParts?.dynamic ?? '').trim();
  const block = dynamicTurnContextBlock(dynamic);
  return openAiChatMessages({
    systemPrompt: request.systemPrompt,
    systemPromptParts: request.systemPromptParts,
    messages: stripBlock(request.messages, block),
  });
}

function historyOf(wire) {
  return wire.filter((message) => message.role !== 'system');
}

function messageTokens(messages) {
  let total = 0;
  for (const message of messages) {
    total += countTokens(`${message.role}\n${contentText(message.content)}`);
  }
  return total;
}

function promptTokens(wire, tools) {
  const system = wire.find((message) => message.role === 'system');
  return (
    countTokens(contentText(system?.content)) +
    countTokens(JSON.stringify(tools ?? [])) +
    messageTokens(historyOf(wire))
  );
}

function turnContextCount(wire) {
  return JSON.stringify(historyOf(wire)).split('<turn-context>').length - 1;
}

test('unchanged environment keeps one turn-context and grows only by new messages', async () => {
  const savedExperience = process.env.MOSS_EXPERIENCE;
  delete process.env.MOSS_EXPERIENCE;
  const captured = [];
  const dynamic = '## Environment\ncwd: /workspace\ngit: clean';
  const agent = new MossAgent({
    llmProvider: endTurnProvider(captured),
    sessionStore: new InMemorySessionStore(),
    model: 'prefix-bytes',
    baseSystemPrompt: 'You are Moss. Stable persona.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 2,
    extraPromptLayers: ['stable project instructions'],
    dynamicPromptLayers: [dynamic],
  });
  try {
    const prompts = ['turn one', 'turn two', 'turn three', 'turn four', 'turn five'];
    for (const prompt of prompts) {
      for await (const event of agent.streamChat('five-turn', prompt)) {
        void event;
      }
    }
    assert.equal(captured.length, 5);
    const after = captured.map((request) => wireOf(request));
    const before = captured.map((request) => legacyWire(request));
    const toolPayloads = captured.map((request) => JSON.stringify(request.tools ?? []));

    assert.equal(turnContextCount(after[4]), 1, 'turn-context appears once in the 5th request');
    assert.equal(after[0][0].content, after[4][0].content, 'system prefix stays byte-identical');
    assert.equal(String(after[0][0].content).includes('git:'), false);
    assert.equal(toolPayloads[0], toolPayloads[4]);

    for (let i = 0; i < 4; i++) {
      const prev = historyOf(after[i]);
      const next = historyOf(after[i + 1]);
      assert.deepEqual(next.slice(0, prev.length), prev, `turn ${i + 2} replays prior messages`);
      const added = next.slice(prev.length);
      assert.equal(JSON.stringify(added).includes('<turn-context>'), false);
      const grew =
        promptTokens(after[i + 1], captured[i + 1].tools) -
        promptTokens(after[i], captured[i].tools);
      assert.equal(grew, messageTokens(added), `turn ${i + 2} grows only by the new messages`);
    }

    const firstAfter = contentText(
      historyOf(after[0]).find((message) => message.role === 'user').content
    );
    const firstLater = contentText(historyOf(after[4])[0].content);
    assert.equal(firstLater, firstAfter);
    const firstBefore = contentText(
      historyOf(before[0]).find((message) => message.role === 'user').content
    );
    const replayBefore = contentText(historyOf(before[1])[0].content);
    assert.notEqual(
      replayBefore,
      firstBefore,
      'reattaching the block changes the previous user message'
    );

    const sum = (wires) =>
      wires.reduce((total, wire, index) => total + promptTokens(wire, captured[index].tools), 0);
    const beforeCumulative = sum(before);
    const afterCumulative = sum(after);
    const cacheableAt = (wires, index) => {
      const prev = historyOf(wires[index - 1]);
      const next = historyOf(wires[index]);
      let shared = 0;
      while (
        shared < prev.length &&
        shared < next.length &&
        JSON.stringify(prev[shared]) === JSON.stringify(next[shared])
      ) {
        shared += 1;
      }
      const system = countTokens(contentText(wires[index][0].content));
      const tools = countTokens(JSON.stringify(captured[index].tools ?? []));
      return system + tools + messageTokens(next.slice(0, shared));
    };
    console.log(
      `[five-turn tokens] cumulative before ${beforeCumulative} after ${afterCumulative}; turn5 before ${promptTokens(before[4], captured[4].tools)} after ${promptTokens(after[4], captured[4].tools)}; cacheable prefix at turn 5 before ${cacheableAt(before, 4)} after ${cacheableAt(after, 4)}`
    );
    assert.equal(afterCumulative <= beforeCumulative + 8, true);
  } finally {
    if (savedExperience === undefined) delete process.env.MOSS_EXPERIENCE;
    else process.env.MOSS_EXPERIENCE = savedExperience;
    await agent.close();
  }
});

test('a changed dynamic suffix is stored on the new user message only', async () => {
  const captured = [];
  const agent = new MossAgent({
    llmProvider: endTurnProvider(captured),
    sessionStore: new InMemorySessionStore(),
    model: 'prefix-bytes',
    baseSystemPrompt: 'You are Moss. Stable persona.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 2,
    dynamicPromptLayers: ['## Environment\ngit: clean'],
  });
  try {
    for await (const event of agent.streamChat('dynamic-change', 'first')) {
      void event;
    }
    agent.config.dynamicPromptLayers = ['## Environment\ngit: dirty'];
    for await (const event of agent.streamChat('dynamic-change', 'second')) {
      void event;
    }
    const wires = captured.map((request) => wireOf(request));
    const first = historyOf(wires[0]);
    const second = historyOf(wires[1]);
    assert.deepEqual(second.slice(0, first.length), first);
    assert.equal(turnContextCount(wires[1]), 2);
    assert.match(contentText(second[0].content), /git: clean/);
    assert.match(contentText(second[second.length - 1].content), /git: dirty/);
    assert.equal(contentText(second[second.length - 1].content).includes('git: clean'), false);
  } finally {
    await agent.close();
  }
});
