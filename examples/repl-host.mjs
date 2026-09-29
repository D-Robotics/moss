#!/usr/bin/env node
// Embedding example 2/3: REPL host with multi-turn session memory.
// The same session key carries conversation history across chat() calls,
// so follow-up questions resolve against earlier answers. Offline mock
// provider: `node examples/repl-host.mjs`
import readline from 'node:readline/promises';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  async complete(options) {
    const transcript = options.messages
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join(' ')
      )
      .join('\n');
    const memoryHit = /blueberry/.test(transcript)
      ? 'yes, you said blueberry earlier in this session'
      : 'no favorite mentioned yet';
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `memory: ${memoryHit}` }] };
  },
  async stream(options, onEvent) {
    const response = await this.complete(options);
    onEvent({ type: 'message_start' });
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
  baseSystemPrompt: 'You are a REPL assistant.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});

const SESSION = 'repl-demo';
const scriptedTurns = ['My favorite fruit is blueberry.', 'What fruit did I mention?', '/quit'];

console.log('mini REPL — type /quit to exit (this demo replays scripted input).');
for (const line of scriptedTurns) {
  console.log(`\n› ${line}`);
  if (line === '/quit') break;
  const result = await agent.chat(SESSION, line);
  console.log(result.response);
}
await agent.close();
