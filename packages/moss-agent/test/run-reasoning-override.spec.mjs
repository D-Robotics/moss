#!/usr/bin/env node
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

const observed = [];
const provider = {
  id: 'reasoning-spy',
  displayName: 'reasoning-spy',
  async complete() {
    throw new Error('not used');
  },
  async stream(options, onEvent) {
    observed.push(options.reasoning);
    onEvent({ type: 'message_start' });
    onEvent({ type: 'content_block_start' });
    onEvent({ type: 'content_block_delta', text: 'ok' });
    onEvent({ type: 'content_block_stop' });
    onEvent({ type: 'message_delta', stopReason: 'end_turn' });
    onEvent({ type: 'message_stop' });
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  },
};
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  workspaceDir: process.cwd(),
  model: 'test',
  reasoning: 'high',
  baseSystemPrompt: 'test',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});
for await (const _event of agent.streamChat('override-off', 'hello', { reasoning: 'off' })) {
}
for await (const _event of agent.streamChat('default-high', 'hello')) {
}
assert.deepEqual(observed, ['off', 'high']);
console.log('[PASS] per-run reasoning override reaches the provider boundary');
