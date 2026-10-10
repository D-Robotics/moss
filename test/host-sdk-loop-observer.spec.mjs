import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MossAgent, InMemorySessionStore } from '../dist/index.js';

test('host observer runs in the producer before provider calls and cannot break a turn', async () => {
  const events = [];
  const identities = [];
  let providerSawTurn = false;
  const response = { stopReason: 'end_turn', content: [{ type: 'text', text: 'observed reply' }] };
  const provider = {
    id: 'observer-test',
    displayName: 'Observer test',
    async complete() {
      return response;
    },
    async stream(_options, emit) {
      providerSawTurn = events.includes('turn_start');
      emit({ type: 'text_delta', text: 'observed reply' });
      return response;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    model: 'test',
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    onAgentLoopEvent(event, identity) {
      events.push(event.type);
      identities.push(identity);
      if (event.type === 'turn_start') throw new Error('diagnostic failure');
    },
  });
  try {
    const result = await agent.chat('owner-session', 'reply', { runId: 'owner-run' });
    assert.equal(result.response, 'observed reply');
    assert.equal(providerSawTurn, true);
    assert.ok(events.includes('turn_end'));
    assert.ok(
      identities.every(
        (identity) => identity.runId === 'owner-run' && identity.sessionKey === 'owner-session'
      )
    );
  } finally {
    await agent.close();
  }
});
