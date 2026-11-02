import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemorySessionStore, MossAgent } from '../dist/index.js';

const thought = 'PRIVATE_THOUGHT_SENTINEL';
const answer = 'I need to explain why this works: the callback runs after the read completes.';

// Only the external model is controlled. The real loop owns tool execution,
// streaming, session persistence and cancellation.
function createAgent({
  buffered,
  onTool = async () => 'Observed a fact.',
  lead = '',
  tool = true,
}) {
  let providerCalls = 0;
  let toolCalls = 0;
  const store = new InMemorySessionStore();
  const respond = async () => {
    if (providerCalls++ > 0) {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: answer }] };
    }
    return {
      stopReason: tool ? 'tool_use' : 'end_turn',
      thinking: [thought],
      content: [
        ...(lead ? [{ type: 'text', text: lead }] : []),
        ...(tool ? [{ type: 'tool_use', id: 'read-call', name: 'inspect', input: {} }] : []),
      ],
    };
  };
  const agent = new MossAgent({
    llmProvider: {
      id: 'controlled-thinking-boundary',
      displayName: 'Offline thinking boundary',
      capabilities: { streaming: true },
      complete: respond,
      stream: async (_request, emit) => {
        const response = await respond();
        for (const text of response.thinking ?? []) {
          emit({ type: 'content_block_delta', text, deltaRole: 'thinking' });
        }
        for (const block of response.content) {
          if (block.type === 'text') {
            emit({ type: 'content_block_delta', text: block.text, deltaRole: 'visible' });
          }
        }
        return response;
      },
    },
    sessionStore: store,
    domainPrompt: false,
    enableCompaction: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    enableThinkingStream: true,
    bufferAssistantUntilComplete: buffered,
  });
  agent.tools.register({
    name: 'inspect',
    description: 'Read one observation',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    execute: async () => {
      toolCalls++;
      return onTool();
    },
  });
  return { agent, store, counts: () => ({ providerCalls, toolCalls }) };
}

function deltas(events, type) {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.delta)
    .join('');
}

for (const buffered of [true, false]) {
  test(`tool-call thinking stays private through completion (buffered=${buffered})`, async () => {
    const { agent, store, counts } = createAgent({ buffered });
    try {
      const events = [];
      for await (const event of agent.streamChat('complete', 'Inspect and explain.'))
        events.push(event);
      assert.equal(deltas(events, 'thinking_delta'), thought);
      assert.equal(deltas(events, 'text_delta'), answer);
      assert.equal(events.find((event) => event.type === 'done')?.result.response, answer);
      assert.deepEqual(counts(), { providerCalls: 2, toolCalls: 1 });
      const firstAssistant = (await store.loadMessages('complete')).find(
        (message) => message.role === 'assistant'
      );
      assert.deepEqual(firstAssistant.thinking, [thought]);
      assert.equal(
        firstAssistant.content.some((block) => block.type === 'tool_use'),
        true
      );
      assert.equal(
        firstAssistant.content.some((block) => block.type === 'text'),
        false
      );
    } finally {
      await agent.close();
    }
  });

  test(`cancellation never promotes tool-call thinking to the answer (buffered=${buffered})`, async () => {
    const abort = new AbortController();
    const { agent, counts } = createAgent({
      buffered,
      onTool: async () => {
        abort.abort();
        return 'Inspection interrupted.';
      },
    });
    try {
      const events = [];
      for await (const event of agent.streamChat('cancel', 'Inspect.', {
        abortSignal: abort.signal,
      })) {
        events.push(event);
      }
      assert.equal(abort.signal.aborted, true);
      assert.equal(counts().toolCalls, 1);
      assert.equal(deltas(events, 'thinking_delta'), thought);
      assert.equal(deltas(events, 'text_delta'), '');
      const result = events.find((event) => event.type === 'done')?.result;
      assert.equal(result?.stopReason, 'aborted_by_user');
      assert.equal(result?.response, '');
    } finally {
      await agent.close();
    }
  });
}

test('keeps explicit English explanations and tool preambles visible without phrase filtering', async () => {
  const lead = 'I should first read the file, then explain the observed behavior.';
  const { agent } = createAgent({ buffered: true, lead });
  try {
    const events = [];
    for await (const event of agent.streamChat('explain', 'Explain your approach and result.'))
      events.push(event);
    assert.equal(deltas(events, 'thinking_delta'), thought);
    assert.equal(deltas(events, 'text_delta'), lead + answer);
    assert.equal(events.find((event) => event.type === 'done')?.result.response, answer);
  } finally {
    await agent.close();
  }
});

test('still retries a thinking-only turn without a tool before producing a visible answer', async () => {
  const { agent, counts } = createAgent({ buffered: true, tool: false });
  try {
    const events = [];
    for await (const event of agent.streamChat('retry', 'Explain the result.')) events.push(event);
    assert.equal(deltas(events, 'thinking_delta'), thought);
    assert.equal(deltas(events, 'text_delta'), answer);
    assert.deepEqual(counts(), { providerCalls: 2, toolCalls: 0 });
  } finally {
    await agent.close();
  }
});
