#!/usr/bin/env node
import assert from 'node:assert/strict';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';

const requests = [];
let call = 0;
const responses = [
  {
    stopReason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'spawn-1',
        name: 'create_subagent',
        input: { task: 'Review without tools', expert: 'no-tools', scope: 'full' },
      },
    ],
  },
  {
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'No-tool expert completed the review.' }],
  },
  {
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'The bounded expert completed successfully.' }],
  },
];

const provider = {
  id: 'expert-runtime-test',
  displayName: 'Expert runtime test',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('streaming provider expected');
  },
  async stream(options, onEvent) {
    requests.push(options);
    const response = responses[call++];
    if (!response) throw new Error(`unexpected provider call ${call}`);
    onEvent({ type: 'message_start' });
    for (const block of response.content) {
      onEvent({ type: 'content_block_start' });
      if (block.type === 'text') {
        onEvent({ type: 'content_block_delta', text: block.text });
      } else {
        onEvent({ type: 'content_block_delta', toolUse: { id: block.id, name: block.name } });
      }
      onEvent({ type: 'content_block_stop' });
    }
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    onEvent({ type: 'message_stop' });
    return response;
  },
};

const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: 'expert-runtime-test',
  baseSystemPrompt: 'Use the configured expert.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  maxAgentTurns: 4,
  subagentExperts: [
    {
      id: 'no-tools',
      displayName: 'No-tools reviewer',
      description: 'Performs a reasoning-only review.',
      instructions: 'Do not claim access to tools; reason only from the task.',
      scope: 'read-only',
      allowedTools: [],
      maxTurns: 1,
    },
  ],
});
registerBuiltinTools(agent);

const result = await agent.chat('expert-runtime', 'Delegate this review.');
assert.match(result.response, /completed successfully/);
assert.equal(requests.length, 3, 'the parent tool call should start one real child request');
assert.deepEqual(
  requests[1].tools ?? [],
  [],
  'an explicit empty expert allowlist reaches the child'
);
assert.match(requests[1].systemPrompt, /Do not claim access to tools/);
assert.match(requests[0].systemPrompt, /no-tools.*Performs a reasoning-only review/s);
assert.doesNotMatch(
  requests[0].systemPrompt,
  /Do not claim access to tools/,
  'trusted instructions are not exposed in the parent catalog'
);

console.log(
  '[PASS] custom expert catalog and empty allowlist survive the real MossAgent child path'
);
