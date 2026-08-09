import test from 'node:test';
import assert from 'node:assert/strict';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

function visibleText(messages) {
  return messages
    .flatMap((message) => {
      if (typeof message.content === 'string') return [message.content];
      return message.content.filter((block) => block.type === 'text').map((block) => block.text);
    })
    .join('\n');
}

test('an admitted steer reaches the next model turn exactly once', async () => {
  const requests = [];
  let providerCall = 0;
  const provider = {
    id: 'steering-inbox-test',
    displayName: 'steering-inbox-test',
    async complete(options) {
      requests.push(options.messages);
      providerCall += 1;
      if (providerCall === 1) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'inspect', input: {} }],
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Applied the new constraint.' }],
      };
    },
    async stream(options, onEvent) {
      const response = await this.complete(options);
      onEvent({ type: 'message_start' });
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          onEvent({ type: 'content_block_start', toolUse: { id: block.id, name: block.name } });
          onEvent({ type: 'content_block_delta', partialJson: '{}' });
          onEvent({ type: 'content_block_stop' });
        } else {
          onEvent({ type: 'content_block_start' });
          onEvent({ type: 'content_block_delta', text: block.text });
          onEvent({ type: 'content_block_stop' });
        }
      }
      onEvent({ type: 'message_delta', stopReason: response.stopReason });
      onEvent({ type: 'message_stop' });
      return response;
    },
  };

  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
  });
  agent.tools.register({
    name: 'inspect',
    description: 'inspect',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      assert.ok(agent.steer('steer-session', 'Use blue instead of red.'));
      return 'inspection complete';
    },
  });

  const result = await agent.chat('steer-session', 'Make the theme red.');

  assert.equal(result.response, 'Applied the new constraint.');
  assert.equal(requests.length, 2);
  assert.doesNotMatch(visibleText(requests[0]), /Use blue instead of red/);
  assert.match(visibleText(requests[1]), /Use blue instead of red/);
  assert.equal(agent.inboxPending('steer-session').length, 0, 'steer is promoted once');
  assert.equal(agent.steer('steer-session', 'This run is already over.'), null);
});

test('steering during a text-only model call creates a follow-up turn', async () => {
  const requests = [];
  let releaseFirstResponse;
  const firstResponseGate = new Promise((resolve) => {
    releaseFirstResponse = resolve;
  });
  let firstRequestStarted;
  const firstRequestGate = new Promise((resolve) => {
    firstRequestStarted = resolve;
  });
  let providerCall = 0;
  const provider = {
    id: 'steering-text-boundary-test',
    displayName: 'steering-text-boundary-test',
    async complete(options) {
      requests.push(options.messages);
      providerCall += 1;
      if (providerCall === 1) {
        firstRequestStarted();
        await firstResponseGate;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Initial answer.' }] };
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Updated answer.' }] };
    },
    async stream(options, onEvent) {
      const response = await this.complete(options);
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: response.content[0].text });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: response.stopReason });
      onEvent({ type: 'message_stop' });
      return response;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
  });

  const run = agent.chat('text-steer-session', 'Answer with red.');
  await firstRequestGate;
  assert.ok(agent.steer('text-steer-session', 'Change the answer to blue.'));
  releaseFirstResponse();
  const result = await run;

  assert.equal(result.response, 'Updated answer.');
  assert.equal(requests.length, 2);
  assert.match(visibleText(requests[1]), /Change the answer to blue/);
  assert.match(visibleText(requests[1]), /Initial answer/);
  assert.equal(agent.inboxPending('text-steer-session').length, 0);
});

test('steer rejects an ambiguous same-session concurrent target', async () => {
  const releases = [];
  const started = [];
  let providerCall = 0;
  const provider = {
    id: 'steering-concurrency-test',
    displayName: 'steering-concurrency-test',
    async complete() {
      const index = providerCall++;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      releases[index] = release;
      started[index]?.();
      await gate;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(options, onEvent) {
      const response = await this.complete(options);
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
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  const waitForStart = (index) =>
    new Promise((resolve) => {
      started[index] = resolve;
    });
  const firstStarted = waitForStart(0);
  const first = agent.chat('shared-steer-session', 'first', { runId: 'first' });
  await firstStarted;
  const secondStarted = waitForStart(1);
  const second = agent.chat('shared-steer-session', 'second', { runId: 'second' });
  await secondStarted;

  assert.equal(agent.steer('shared-steer-session', 'ambiguous update'), null);
  releases[0]();
  releases[1]();
  await Promise.all([first, second]);
});
