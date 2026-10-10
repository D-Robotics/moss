#!/usr/bin/env node
/**
 * Output-limit recovery: thinking-only cutoffs retry, mid-text output is
 * stitched, a truncated tool call is not executed, and exhausting the
 * recovery budget ends as a non-success with stop_reason populated.
 */
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { runOneShot } from '../dist/cli/oneshot.js';

function scriptedProvider(id, steps) {
  let calls = 0;
  const maxTokens = [];
  return {
    maxTokens,
    calls: () => calls,
    provider: {
      id,
      capabilities: { streaming: true },
      async complete() {
        throw new Error('complete() is not used');
      },
      async stream(request, onEvent) {
        const step = steps[calls] ?? steps[steps.length - 1];
        calls += 1;
        maxTokens.push(request.maxTokens);
        if (step.thinking) {
          onEvent({
            type: 'content_block_delta',
            text: step.thinking,
            deltaRole: 'thinking',
          });
        }
        if (step.text) {
          onEvent({ type: 'content_block_delta', text: step.text });
        }
        onEvent({ type: 'message_stop' });
        const content = [];
        if (step.text) content.push({ type: 'text', text: step.text });
        if (step.tool) {
          content.push({
            type: 'tool_use',
            id: `call_${calls}`,
            name: step.tool.name,
            input: step.tool.input,
          });
        }
        return {
          stopReason: step.stopReason,
          content,
          ...(step.thinking ? { thinking: [step.thinking] } : {}),
          usage: { inputTokens: 12, outputTokens: 8 },
        };
      },
    },
  };
}

function createAgent(provider, extra = {}) {
  return new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'glm-5.3',
    baseSystemPrompt: 'Answer directly.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 8,
    maxTokens: 1024,
    ...extra,
  });
}

async function runChat(agent, sessionKey, message) {
  const events = [];
  let result;
  for await (const event of agent.streamChat(sessionKey, message)) {
    events.push(event);
    if (event.type === 'done') result = event.result;
  }
  assert.ok(result, 'chat produced a done result');
  return { result, events };
}

{
  const script = scriptedProvider('thinking-cutoff', [
    { thinking: 'deliberating about the whole task', stopReason: 'max_tokens' },
    { thinking: 'still deliberating', stopReason: 'max_tokens' },
    { text: 'shipped the change', stopReason: 'end_turn' },
  ]);
  const agent = createAgent(script.provider);
  const { result, events } = await runChat(agent, 'thinking-cutoff', 'do the task');
  assert.equal(script.calls(), 3, 'two truncated thinking turns then one visible answer');
  assert.equal(result.response, 'shipped the change');
  assert.notEqual(result.stopReason, 'output_limit');
  assert.equal(result.toolCalls.length, 0);
  assert.ok(
    script.maxTokens[0] === 1024,
    `first cap stays the configured 1024, got ${script.maxTokens[0]}`
  );
  assert.ok(script.maxTokens[1] > script.maxTokens[0], 'thinking cutoff raises the output budget');
  assert.ok(script.maxTokens[2] >= script.maxTokens[1]);
  const continuations = events.filter((event) => event.type === 'output_continuation');
  assert.equal(continuations.length, 2);
  assert.equal(
    continuations.every((event) => event.exhausted !== true),
    true
  );
  const truncatedTurns = events.filter(
    (event) => event.type === 'turn_end' && event.stopReason === 'max_tokens'
  );
  assert.ok(truncatedTurns.length >= 2, 'truncated turns publish stopReason max_tokens');
  console.log('[PASS] thinking-only truncation retries with a larger budget');
}

{
  const script = scriptedProvider('mid-text', [
    { text: 'Hello ', stopReason: 'max_tokens' },
    { text: 'world', stopReason: 'end_turn' },
  ]);
  const agent = createAgent(script.provider);
  const { result } = await runChat(agent, 'mid-text', 'say hello world');
  assert.equal(result.response, 'Hello world');
  assert.equal(script.calls(), 2);
  assert.notEqual(result.stopReason, 'output_limit');
  console.log('[PASS] mid-text truncation is stitched');
}

{
  let executions = 0;
  const script = scriptedProvider('partial-tool', [
    {
      tool: { name: 'write_note', input: { text: 'trunc' } },
      stopReason: 'max_tokens',
    },
    { text: 'wrote nothing', stopReason: 'end_turn' },
  ]);
  const agent = createAgent(script.provider);
  agent.tools.register({
    name: 'write_note',
    description: 'Write a note.',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async execute() {
      executions += 1;
      return 'noted';
    },
  });
  const { result, events } = await runChat(agent, 'partial-tool', 'write a note');
  assert.equal(executions, 0, 'a truncated tool call is not executed');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(
    events.some((event) => event.type === 'tool_start'),
    false
  );
  assert.equal(result.response, 'wrote nothing');
  assert.equal(script.calls(), 2);
  console.log('[PASS] truncated tool call is discarded');
}

{
  const script = scriptedProvider('exhausted', [
    { text: '&&', stopReason: 'length' },
    { text: 'Now', stopReason: 'max_tokens' },
    { text: ' still', stopReason: 'length' },
    { text: ' going', stopReason: 'max_tokens' },
    { text: 'should-not-run', stopReason: 'end_turn' },
  ]);
  const agent = createAgent(script.provider);
  const { result, events } = await runChat(agent, 'exhausted', 'keep going');
  assert.equal(script.calls(), 4, 'recovery stops after the continuation cap');
  assert.equal(result.stopReason, 'output_limit');
  assert.equal(result.response, '&&Now still going');
  const exhausted = events.filter(
    (event) => event.type === 'output_continuation' && event.exhausted === true
  );
  assert.equal(exhausted.length, 1);
  console.log('[PASS] exhausted recovery is a non-success and keeps the stitched fragment');
}

function createWriter() {
  let output = '';
  return {
    writer: {
      write(chunk) {
        output += chunk;
        return true;
      },
    },
    events() {
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    text() {
      return output;
    },
  };
}

const savedExitCode = process.exitCode;
try {
  {
    const script = scriptedProvider('headless-recover', [
      { text: 'Hello ', stopReason: 'max_tokens' },
      { text: 'world', stopReason: 'end_turn' },
    ]);
    const agent = createAgent(script.provider);
    const output = createWriter();
    await runOneShot(agent, 'say hello world', {
      sessionKey: 'headless-output-limit-recover',
      outputFormat: 'stream-json',
      stdout: output.writer,
    });
    const events = output.events();
    const truncated = events.find(
      (event) =>
        event.type === 'assistant' &&
        event.message?.content?.some((block) => block.type === 'text' && block.text === 'Hello ')
    );
    assert.ok(truncated, 'truncated assistant message is emitted');
    assert.equal(truncated.message.stop_reason, 'max_tokens');
    const notices = events.filter(
      (event) => event.type === 'system' && event.subtype === 'output_continuation'
    );
    assert.ok(notices.length >= 1, 'stream-json emits an output_continuation notice');
    assert.match(notices[0].message, /Output limit reached/);
    const result = events[events.length - 1];
    assert.equal(result.type, 'result');
    assert.equal(result.subtype, 'success');
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'Hello world');
    console.log('[PASS] stream-json populates stop_reason and reports a recovered success');
  }

  {
    const script = scriptedProvider('headless-exhaust', [
      { text: '&&', stopReason: 'length' },
      { text: 'Now', stopReason: 'max_tokens' },
      { text: '!', stopReason: 'length' },
      { text: '?', stopReason: 'max_tokens' },
    ]);
    const agent = createAgent(script.provider);
    const output = createWriter();
    await runOneShot(agent, 'finish the answer', {
      sessionKey: 'headless-output-limit-exhaust',
      outputFormat: 'stream-json',
      stdout: output.writer,
    });
    const events = output.events();
    const assistants = events.filter((event) => event.type === 'assistant');
    assert.ok(
      assistants.some((event) => event.message.stop_reason === 'max_tokens'),
      'exhausted fragments keep stop_reason max_tokens'
    );
    const notices = events.filter(
      (event) => event.type === 'system' && event.subtype === 'output_continuation'
    );
    assert.ok(notices.some((event) => event.exhausted === true));
    const result = events[events.length - 1];
    assert.equal(result.type, 'result');
    assert.equal(result.subtype, 'error_output_limit');
    assert.equal(result.is_error, true);
    assert.equal(result.result, '&&Now!?');
    assert.match(result.error, /maxOutputTokens/);
    assert.notEqual(result.subtype, 'success');
    console.log('[PASS] exhausted -p stream-json run is error_output_limit, not success');
  }

  {
    const script = scriptedProvider('headless-text', [
      { text: '&&', stopReason: 'length' },
      { text: 'Now', stopReason: 'max_tokens' },
      { text: '!', stopReason: 'length' },
      { text: '?', stopReason: 'max_tokens' },
    ]);
    const agent = createAgent(script.provider);
    const output = createWriter();
    let stderr = '';
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (...args) => {
      stderr += String(args[0]);
      return originalWrite(...args);
    };
    try {
      await runOneShot(agent, 'finish the answer in text', {
        sessionKey: 'headless-output-limit-text',
        outputFormat: 'text',
        stdout: output.writer,
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(stderr, /Output limit reached/);
    assert.match(stderr, /maxOutputTokens/);
    assert.equal(script.calls(), 4);
    console.log('[PASS] text -p run completes and prints the output-limit notice');
  }
} finally {
  process.exitCode = savedExitCode;
}

console.log('[PASS] output-limit recovery');
