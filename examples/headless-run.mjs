#!/usr/bin/env node
// Embedding example 1/3: headless run with JSONL-style event stream.
// No API key needed — the LLM provider is a scripted mock, so this runs
// offline: `node examples/headless-run.mjs`
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  calls: 0,
  async complete(options) {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-1', name: 'get_status', input: {} }],
      };
    }
    const toolResult = options.messages.at(-1)?.content?.find?.((b) => b?.type === 'tool_result');
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: `status check done: ${toolResult?.content ?? '?'}` }],
    };
  },
  async stream(options, onEvent) {
    const response = await this.complete(options);
    onEvent({ type: 'message_start' });
    for (const block of response.content) {
      onEvent({
        type: 'content_block_start',
        ...(block.type === 'tool_use' ? { toolUse: { id: block.id, name: block.name } } : {}),
      });
      onEvent(
        block.type === 'tool_use'
          ? { type: 'content_block_delta', partialJson: JSON.stringify(block.input) }
          : { type: 'content_block_delta', text: block.text }
      );
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
  baseSystemPrompt: 'You are an embedded status agent.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});

agent.tools.register({
  name: 'get_status',
  description: 'Return the current service status.',
  metadata: { sideEffectClass: 'readonly' },
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return 'ok, uptime 42s';
  },
});

const result = await agent.chat('headless-demo', 'Check the service status.', {
  onStream: (event) => console.log(JSON.stringify({ type: event.type })),
});

console.log(`final response: ${result.response}`);
console.log(`stop reason: ${result.stopReason}`);
await agent.close();
