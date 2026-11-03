import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MossAgent } from '../dist/index.js';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import { PiAiLLMProvider } from '../dist/provider/pi-ai-adapter.js';
import { truncateToolOutput } from '../dist/context/tool-output-truncate.js';

async function runStructuredTool(content, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-structured-text-budget-'));
  const sessionKey = 'structured-evidence';
  const wire = [];
  let executions = 0;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: { api: 'openai-completions', provider: 'test', id: 'test-model' },
    streamFn: async function* (_model, context) {
      wire.push(structuredClone(context.messages));
      if (wire.length === 1) {
        yield {
          type: 'toolcall_end',
          toolCall: { id: 'evidence-1', name: 'qa_structured', arguments: {} },
        };
        yield { type: 'done', stopReason: 'toolUse' };
      } else {
        yield { type: 'text_delta', delta: 'Evidence received.' };
        yield { type: 'done', stopReason: 'stop' };
      }
    },
  });
  const agent = new MossAgent({
    llmProvider: provider,
    model: 'test-model',
    sessionStore: new JsonlSessionStore({ dir }),
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    hooks: { onBeforeToolExec: async () => ({ approved: true }) },
  });
  if (options.redact) {
    agent.registerPostToolHook({
      name: 'redact-structured',
      priority: 1,
      async process() {
        return { result: '[redacted]' };
      },
    });
  }
  agent.tools.register({
    name: 'qa_structured',
    description: 'Return owned structured test evidence.',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly', noReplay: true },
    execute: async () => assert.fail('the real loop must use executeStructured'),
    executeStructured: async () => {
      executions += 1;
      return { content, isError: false };
    },
  });
  try {
    const events = [];
    for await (const event of agent.streamChat(sessionKey, 'Read this data and acknowledge it.')) {
      events.push(event);
    }
    assert.equal(executions, 1);
    assert.equal(wire.length, 2, 'the provider must receive the tool result and finish normally');
    assert.ok(events.every((event) => event.type !== 'error'));
    const done = events.find((event) => event.type === 'done');
    assert.equal(done?.result.response, 'Evidence received.');
    const end = events.find((event) => event.type === 'tool_end');
    assert.equal(end?.isError, false, 'a data string containing failure words is not a tool error');
    const persisted = await new JsonlSessionStore({ dir }).loadMessages(sessionKey);
    const durable = persisted
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === 'tool_result' && block.tool_use_id === 'evidence-1');
    const sent = wire[1].find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'evidence-1'
    );
    assert.ok(durable, 'a fresh store must reload the result from JSONL');
    assert.ok(sent, 'the real PiAi adapter must send the tool result');
    assert.equal(durable.is_error, false);
    assert.equal(sent.isError, false);
    let resumedWireText;
    if (options.resume) {
      for await (const _event of agent.streamChat(sessionKey, 'Continue with the same evidence.')) {
        // Drain the resumed run so that its provider request is observable.
      }
      const resumed = wire
        .at(-1)
        .find((message) => message.role === 'toolResult' && message.toolCallId === 'evidence-1');
      assert.ok(resumed, 'resumed provider request must include the persisted tool result');
      resumedWireText = resumed.content.map((block) => block.text ?? '').join('');
    }
    return {
      end,
      durable,
      sent,
      wireText: sent.content.map((block) => block.text ?? '').join(''),
      resumedWireText,
    };
  } finally {
    await agent.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a 14k JSON text result stays valid and identical in durable storage and provider wire', async () => {
  const data = { note: 'Test Results: ❌ is literal data', body: 'x'.repeat(14_000) };
  const text = JSON.stringify(data);
  assert.ok(text.length > 12_000 && Buffer.byteLength(text) < 16_000);
  const { end, durable, wireText } = await runStructuredTool([{ type: 'text', text }]);
  assert.equal(durable.content, text);
  assert.equal(end.content, text);
  assert.equal(wireText, durable.content, 'provider wire must not append a structured notice');
  assert.deepEqual(JSON.parse(wireText), data);
  assert.doesNotMatch(wireText, /structured content truncated/);
});

test('large pure-text blocks keep their existing joined text without duplicate metadata', async () => {
  const content = [
    { type: 'text', text: 'a'.repeat(7_000) },
    { type: 'text', text: 'b'.repeat(7_000) },
  ];
  const expected = content.map((block) => block.text).join('\n');
  const { end, durable, wireText } = await runStructuredTool(content);
  assert.equal(end.content, expected);
  assert.equal(durable.content, expected);
  assert.equal(wireText, expected);
});

test('pure-text metadata cannot bypass the existing per-tool text budget', async () => {
  const text = `START\n${'界'.repeat(30_000)}\nEND`;
  const bounded = truncateToolOutput('qa_structured', text);
  assert.match(bounded, /tokens truncated/);
  const { end, durable, wireText } = await runStructuredTool([{ type: 'text', text }]);
  assert.equal(end.content, bounded);
  assert.equal(durable.content, bounded);
  assert.equal(wireText, bounded);
  assert.equal(durable.structuredContent, undefined);
  assert.ok(Buffer.byteLength(wireText) < 16_500);
});

for (const block of [
  { type: 'image', mimeType: 'image/png', data: 'A'.repeat(12_100) },
  { type: 'resource', uri: 'qa://owned/evidence', text: 'r'.repeat(12_100) },
]) {
  test(`oversized ${block.type} metadata keeps the existing structured-content cap`, async () => {
    const { end, durable, wireText } = await runStructuredTool([block]);
    assert.equal(durable.structuredContent.length, 1);
    assert.equal(durable.structuredContent[0].type, 'text');
    assert.match(durable.structuredContent[0].text, /structured content truncated/);
    assert.deepEqual(end.structuredContent, durable.structuredContent);
    const expectedContent = block.type === 'image' ? '[1 content block(s): image]' : block.text;
    assert.equal(end.content, expectedContent, 'SDK tool content remains unchanged');
    assert.equal(durable.content, expectedContent, 'persisted tool content remains unchanged');
    assert.equal(wireText, `${expectedContent}\n${durable.structuredContent[0].text}`);
  });
}

test('a generated truncation notice survives session reload without changing SDK resource text', async () => {
  const payload = { value: 'x'.repeat(12_100) };
  const text = JSON.stringify(payload);
  const { end, wireText, resumedWireText } = await runStructuredTool(
    [{ type: 'resource', uri: 'qa://owned/reload', text }],
    { resume: true }
  );
  assert.deepEqual(JSON.parse(end.content), payload);
  assert.match(wireText, /structured content truncated/);
  assert.equal(resumedWireText, wireText);
});

test('a post-hook redaction drops oversized structured data and its truncation notice', async () => {
  const { end, durable, wireText, resumedWireText } = await runStructuredTool(
    [{ type: 'image', mimeType: 'image/png', data: 'sensitive-fixture'.repeat(1_000) }],
    { redact: true, resume: true }
  );
  assert.equal(end.content, '[redacted]');
  assert.equal(durable.content, '[redacted]');
  assert.equal(durable.structuredContent, undefined);
  assert.equal(durable._structuredContentTruncated, undefined);
  assert.equal(wireText, '[redacted]');
  assert.equal(resumedWireText, '[redacted]');
  assert.doesNotMatch(JSON.stringify(end), /sensitive-fixture/);
});

test('small mixed image and text metadata retains its existing durable representation', async () => {
  const content = [
    { type: 'text', text: 'owned image evidence' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
  ];
  const { end, durable, wireText } = await runStructuredTool(content);
  assert.deepEqual(durable.structuredContent, content);
  assert.deepEqual(end.structuredContent, content);
  assert.equal(wireText, 'owned image evidence');
});
