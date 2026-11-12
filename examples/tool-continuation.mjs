#!/usr/bin/env node
// Durable suspension and restart, using an offline provider and the public SDK.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MossAgent, JsonlSessionStore, suspendToolCall } from '../dist/index.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-continuation-'));
let writes = 0;
let requests = 0;
const provider = {
  id: 'continuation-example',
  displayName: 'Offline continuation example',
  capabilities: { streaming: true },
  async complete(options) {
    requests++;
    if (requests === 1)
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'write-before', name: 'record_value', input: {} },
          { type: 'tool_use', id: 'wait-call', name: 'await_reply', input: {} },
          { type: 'tool_use', id: 'write-after', name: 'record_value', input: {} },
        ],
      };
    const results = options.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const reply = results.find((b) => b.type === 'tool_result' && b.tool_use_id === 'wait-call');
    assert.equal(reply?.content, 'answer from peer');
    return { stopReason: 'end_turn', content: [{ type: 'text', text: reply.content }] };
  },
  async stream(options, emit) {
    const result = await this.complete(options);
    emit({ type: 'message_start' });
    for (const block of result.content) {
      emit({
        type: 'content_block_start',
        ...(block.type === 'tool_use' ? { toolUse: { id: block.id, name: block.name } } : {}),
      });
      emit(
        block.type === 'tool_use'
          ? { type: 'content_block_delta', partialJson: JSON.stringify(block.input) }
          : { type: 'content_block_delta', text: block.text }
      );
      emit({ type: 'content_block_stop' });
    }
    emit({ type: 'message_delta', stopReason: result.stopReason });
    emit({ type: 'message_stop' });
    return result;
  },
};
function makeAgent() {
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new JsonlSessionStore({ dir: directory }),
    baseSystemPrompt: 'Use only the supplied tools.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  agent.tools.register({
    name: 'record_value',
    description: 'Record an example value.',
    metadata: { sideEffectClass: 'runtime_state' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      writes++;
      return 'recorded';
    },
  });
  agent.tools.register({
    name: 'await_reply',
    description: 'Wait for a host-provided answer.',
    metadata: { sideEffectClass: 'runtime_state', canSuspend: true, noReplay: true },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      suspendToolCall({ continuationId: 'wait-1', payload: { question: 'peer-question' } });
    },
  });
  return agent;
}
try {
  const first = makeAgent();
  const suspended = await first.chat('example', 'Record a value, then wait for the peer.', {
    taskFlow: false,
  });
  assert.equal(suspended.stopReason, 'suspended');
  assert.equal(suspended.suspendedTool?.continuationId, 'wait-1');
  assert.equal(writes, 1);
  assert.equal(requests, 1);
  await first.close();
  const restarted = makeAgent();
  assert.equal((await restarted.getPendingTool('example'))?.toolCallId, 'wait-call');
  await assert.rejects(restarted.compactSession('example'));
  await assert.rejects(restarted.chat('example', 'Do not replace the pending call.'));
  await assert.rejects(
    restarted.resumePendingTool('example', {
      continuationId: 'wrong',
      toolCallId: 'wait-call',
      result: { toolUseId: 'wait-call', content: 'bad' },
    })
  );
  const result = await restarted.resumePendingTool(
    'example',
    {
      continuationId: 'wait-1',
      toolCallId: 'wait-call',
      result: { toolUseId: 'wait-call', content: 'answer from peer', isError: false },
    },
    { taskFlow: false }
  );
  assert.equal(result.response, 'answer from peer');
  assert.equal(writes, 1);
  assert.equal(await restarted.getPendingTool('example'), undefined);
  await assert.rejects(
    restarted.resumePendingTool('example', {
      continuationId: 'wait-1',
      toolCallId: 'wait-call',
      result: { toolUseId: 'wait-call', content: 'duplicate' },
    })
  );
  assert.equal(requests, 2);
  await restarted.close();
  console.log('Durable tool suspension, restart, guarded continuation and no replay verified.');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
