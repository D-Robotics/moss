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
import { setTuiLocale } from '../dist/cli/tui/copy.js';

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
        const tools = step.tools ?? (step.tool ? [step.tool] : []);
        for (const tool of tools) {
          content.push({
            type: 'tool_use',
            id: tool.id ?? `call_${calls}_${tool.name}`,
            name: tool.name,
            input: tool.input,
          });
        }
        return {
          stopReason: step.stopReason,
          content,
          ...(step.thinking ? { thinking: [step.thinking] } : {}),
          usage: step.usage ?? { inputTokens: 12, outputTokens: 8 },
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
  const hits = { alpha: 0, beta: 0 };
  const script = scriptedProvider('parallel-tools', [
    {
      tools: [
        { name: 'write_alpha', input: { text: 'complete-looking' } },
        { name: 'write_beta', input: { text: 'also-complete' } },
      ],
      stopReason: 'max_tokens',
    },
    { text: 'did not write', stopReason: 'end_turn' },
  ]);
  const agent = createAgent(script.provider);
  for (const name of ['write_alpha', 'write_beta']) {
    agent.tools.register({
      name,
      description: 'Write a note.',
      metadata: { sideEffectClass: 'readonly' },
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      async execute() {
        hits[name === 'write_alpha' ? 'alpha' : 'beta'] += 1;
        return 'noted';
      },
    });
  }
  const { result, events } = await runChat(agent, 'parallel-tools', 'write both notes');
  assert.equal(hits.alpha, 0, 'the first parallel tool call is not executed');
  assert.equal(hits.beta, 0, 'the second parallel tool call is not executed');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(
    events.some((event) => event.type === 'tool_start'),
    false
  );
  assert.equal(result.response, 'did not write');
  assert.equal(script.calls(), 2);
  console.log('[PASS] a truncated parallel tool batch is not executed');
}

{
  const script = scriptedProvider('stitch-account', [
    {
      text: 'abcabc',
      stopReason: 'max_tokens',
      usage: { inputTokens: 10, outputTokens: 11 },
    },
    {
      text: 'abc',
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 22 },
    },
  ]);
  const agent = createAgent(script.provider);
  const { result, events } = await runChat(agent, 'stitch-account', 'repeat abc');
  assert.equal(result.response, 'abcabcabc');
  assert.equal(result.response.split('abc').length - 1, 3);
  const usageEvents = events.filter((event) => event.type === 'llm_usage');
  assert.equal(usageEvents.length, 2);
  const outputSum = usageEvents.reduce((sum, event) => sum + event.outputTokens, 0);
  const inputSum = usageEvents.reduce((sum, event) => sum + event.inputTokens, 0);
  assert.equal(outputSum, 33);
  assert.equal(inputSum, 30);
  assert.equal(result.usage?.outputTokens, outputSum);
  assert.equal(result.usage?.inputTokens, inputSum);
  console.log('[PASS] continuation stitch and token accounting keep every piece');
}

{
  const script = scriptedProvider('exhausted', [
    { text: '&&', stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 11 } },
    { text: 'Now', stopReason: 'max_tokens', usage: { inputTokens: 20, outputTokens: 22 } },
    { text: ' still', stopReason: 'max_tokens', usage: { inputTokens: 30, outputTokens: 33 } },
    { text: ' going', stopReason: 'max_tokens', usage: { inputTokens: 40, outputTokens: 44 } },
    {
      text: 'should-not-run',
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 55 },
    },
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
  assert.equal(exhausted[0].attempt, 3);
  assert.equal(exhausted[0].maxAttempts, 3);
  const continued = events.filter(
    (event) => event.type === 'output_continuation' && event.exhausted !== true
  );
  assert.deepEqual(
    continued.map((event) => event.attempt),
    [1, 2, 3]
  );
  const usageEvents = events.filter((event) => event.type === 'llm_usage');
  assert.equal(usageEvents.length, 4, 'every continuation is accounted, and the fifth call is not');
  const outputSum = usageEvents.reduce((sum, event) => sum + event.outputTokens, 0);
  const inputSum = usageEvents.reduce((sum, event) => sum + event.inputTokens, 0);
  assert.equal(outputSum, 110);
  assert.equal(inputSum, 100);
  assert.equal(result.usage?.outputTokens, outputSum);
  assert.equal(result.usage?.inputTokens, inputSum);
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
      { text: '&&', stopReason: 'max_tokens' },
      { text: 'Now', stopReason: 'max_tokens' },
      { text: '!', stopReason: 'max_tokens' },
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
      { text: '&&', stopReason: 'max_tokens' },
      { text: 'Now', stopReason: 'max_tokens' },
      { text: '!', stopReason: 'max_tokens' },
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
    assert.notEqual(process.exitCode, 0, 'a text run cut off by the output limit is not exit 0');
    assert.notEqual(process.exitCode, undefined);
    console.log('[PASS] text -p run completes and prints the output-limit notice');
  }

  {
    const savedDisable = process.env.MOSS_DISABLE_NUDGES;
    process.env.MOSS_DISABLE_NUDGES = 'output-continuation';
    try {
      const script = scriptedProvider('headless-ablation', [
        { text: 'partial answer', stopReason: 'max_tokens' },
        { text: 'should-not-run', stopReason: 'end_turn' },
      ]);
      const agent = createAgent(script.provider);
      const output = createWriter();
      await runOneShot(agent, 'finish', {
        sessionKey: 'headless-output-limit-ablation',
        outputFormat: 'stream-json',
        stdout: output.writer,
      });
      const events = output.events();
      const result = events[events.length - 1];
      assert.equal(
        script.calls(),
        1,
        'disabling continuation does not start another provider call'
      );
      assert.equal(result.type, 'result');
      assert.equal(result.subtype, 'error_output_limit');
      assert.equal(result.is_error, true);
      assert.notEqual(result.subtype, 'success');
      assert.equal(result.result, 'partial answer');
      const notices = events.filter(
        (event) => event.type === 'system' && event.subtype === 'output_continuation'
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0].exhausted, true);
      console.log('[PASS] a disabled continuation still ends as error_output_limit');
    } finally {
      if (savedDisable === undefined) delete process.env.MOSS_DISABLE_NUDGES;
      else process.env.MOSS_DISABLE_NUDGES = savedDisable;
    }
  }

  {
    setTuiLocale(true);
    try {
      const script = scriptedProvider('headless-zh', [
        { text: '片段', stopReason: 'max_tokens' },
        { text: '未发出', stopReason: 'max_tokens' },
        { text: '仍未', stopReason: 'max_tokens' },
        { text: '结束', stopReason: 'max_tokens' },
      ]);
      const agent = createAgent(script.provider);
      const output = createWriter();
      await runOneShot(agent, '用中文结束', {
        sessionKey: 'headless-output-limit-zh',
        outputFormat: 'stream-json',
        stdout: output.writer,
      });
      const events = output.events();
      const notices = events.filter(
        (event) => event.type === 'system' && event.subtype === 'output_continuation'
      );
      assert.ok(notices.length >= 2);
      for (const notice of notices) {
        assert.match(notice.message, /输出已到上限|已自动续写/);
        assert.equal(notice.message.includes('Output limit reached'), false);
        assert.equal(notice.message.includes('The answer above is incomplete'), false);
      }
      const exhausted = notices.find((event) => event.exhausted === true);
      assert.ok(exhausted);
      assert.match(exhausted.message, /已自动续写/);
      assert.match(exhausted.message, /上面的回答不完整/);
      const result = events[events.length - 1];
      assert.equal(result.subtype, 'error_output_limit');
      assert.match(result.error, /已自动续写/);
      assert.equal(result.error.includes('The answer above is incomplete'), false);
      console.log('[PASS] zh output-limit notices stay Chinese');
    } finally {
      setTuiLocale(false);
    }
  }
} finally {
  process.exitCode = savedExitCode;
}

console.log('[PASS] output-limit recovery');
