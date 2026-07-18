import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import {
  createSideChatAgent,
  prepareSideChatSession,
  resolveSideChatSourceSessionKey,
  sideChatRunOptions,
} from '../dist/cli/side-chat.js';
import { TranscriptMessage } from '../dist/cli/tui.js';
import { filterToolsForRun } from '../dist/core/tools/tool-filter.js';

const readonlyTool = {
  name: 'read_file',
  description: 'read',
  metadata: { sideEffectClass: 'readonly' },
  inputSchema: { type: 'object', properties: {} },
  async execute() { return 'ok'; },
};
const writeTool = {
  name: 'write_file',
  description: 'write',
  metadata: { sideEffectClass: 'local_write' },
  inputSchema: { type: 'object', properties: {} },
  async execute() { return 'ok'; },
};

test('per-run tool filter limits the visible and executable tool set', () => {
  const filtered = filterToolsForRun([readonlyTool, writeTool], (tool) => tool.metadata?.sideEffectClass === 'readonly');
  assert.deepEqual(filtered.map((tool) => tool.name), ['read_file']);
});

test('side chat inherits a snapshot without polluting the main session', async () => {
  const store = new InMemorySessionStore();
  await store.appendMessage('main', { role: 'user', content: 'Please improve math.js' });
  await store.appendMessage('main', { role: 'assistant', content: 'I will inspect math.js and math.test.js.' });

  await prepareSideChatSession(store, 'main', 'btw-1');
  assert.deepEqual(await store.loadMessages('btw-1'), await store.loadMessages('main'));

  await store.appendMessage('btw-1', { role: 'user', content: 'Which files?' });
  assert.equal((await store.loadMessages('main')).length, 2, 'main session remains unchanged');
  assert.equal((await store.loadMessages('btw-1')).length, 3, 'side chat continues independently');
});

test('side chat prefers the active loop session snapshot', () => {
  assert.equal(resolveSideChatSourceSessionKey('main', 'loop:3'), 'loop:3');
  assert.equal(resolveSideChatSourceSessionKey('main', undefined), 'main');
});

test('side chat defaults to a fast context-only answer', () => {
  const options = sideChatRunOptions();
  assert.equal(options.maxTurns, 2);
  assert.equal(options.maxToolCalls, 0);
  assert.equal(options.reasoning, 'off');
  assert.equal(options.maxOutputTokens, 400);
  assert.match(options.extraContext, /answer only the side question/i);
  assert.match(options.extraContext, /do not continue the inherited main task/i);
  assert.match(options.extraContext, /only actionable user request/i);
});

import { MossAgent } from '../dist/core/agent/moss-agent.js';

test('MossAgent enforces the per-run tool filter at the provider boundary', async () => {
  const seenToolNames = [];
  let writeExecutions = 0;
  const provider = {
    id: 'tool-filter-test',
    displayName: 'tool-filter-test',
    async complete(options) {
      seenToolNames.push(...(options.tools ?? []).map((tool) => tool.name));
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(options, onEvent) {
      seenToolNames.push(...(options.tools ?? []).map((tool) => tool.name));
      const response = { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: 'done' });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return response;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  agent.tools.register(readonlyTool);
  agent.tools.register({
    ...writeTool,
    async execute() {
      writeExecutions++;
      return 'wrote';
    },
  });

  await agent.chat('filtered', 'answer this', {
    toolFilter: (tool) => tool.metadata?.sideEffectClass === 'readonly',
  });

  assert.deepEqual(seenToolNames, ['read_file']);
  assert.equal(writeExecutions, 0);
});

test('side chat uses an independent MossAgent with only readonly tools', async () => {
  const store = new InMemorySessionStore();
  const provider = {
    id: 'side-agent-test',
    displayName: 'side-agent-test',
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(_options, onEvent) {
      const response = { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: 'done' });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return response;
    },
  };
  const main = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'main',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    recordLlmUsage: true,
    llmUsageLogPath: '/tmp/side-chat-usage.jsonl',
  });
  main.tools.register(readonlyTool);
  main.tools.register(writeTool);

  const side = createSideChatAgent(main);
  assert.notEqual(side, main);
  assert.deepEqual(side.tools.getNames(), ['read_file']);
  assert.equal(side.config.sessionStore, main.config.sessionStore);
  assert.equal(side.config.llmProvider, main.config.llmProvider);
  assert.equal(side.config.recordLlmUsage, true);
  assert.equal(side.config.llmUsageLogPath, '/tmp/side-chat-usage.jsonl');
});

test('aborted side chat renders stopped instead of done and preserves partial output', () => {
  const rendered = render(React.createElement(TranscriptMessage, {
    item: {
      id: 99,
      kind: 'assistant',
      text: 'Partial side-chat answer',
      channel: 'btw',
      status: 'failed',
      finalized: true,
      elapsedMs: 250,
    },
  }));

  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /BTW · stopped/i);
  assert.match(frame, /Partial side-chat answer/);
  assert.doesNotMatch(frame, /BTW · done/i);
});
