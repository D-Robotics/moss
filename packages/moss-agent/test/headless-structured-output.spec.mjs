#!/usr/bin/env node
import assert from 'node:assert/strict';

import { runOneShot } from '../dist/cli/oneshot.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createStructuredOutputTool } from '../dist/structured-output/structured-output-tool.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const schema = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name', 'age'],
  additionalProperties: false,
};

function createAgent(transcript, maxRetries = 2, model = 'headless-structured') {
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider(
      'headless-structured',
      'Headless Structured',
      transcript
    ),
    sessionStore: new InMemorySessionStore(),
    model,
    baseSystemPrompt: 'Return the requested structured output.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 8,
  });
  agent.tools.register(createStructuredOutputTool({ maxRetries }));
  return agent;
}

function createWriter() {
  let output = '';
  return {
    writer: {
      write(chunk) {
        output += chunk;
      },
    },
    events() {
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

const originalExitCode = process.exitCode;
try {
  process.exitCode = undefined;
  const successOutput = createWriter();
  const successAgent = createAgent([
    { toolCalls: [{ name: 'generate_structured', input: { schema, prompt: 'profile' } }] },
    { text: '```json\n{"name":"Ada","age":30}\n```' },
  ]);
  await runOneShot(successAgent, 'Return a structured profile.', undefined, {
    sessionKey: 'headless-structured-success',
    outputFormat: 'stream-json',
    stdout: successOutput.writer,
  });
  const successEvents = successOutput.events();
  assert.ok(
    successEvents.length >= 4,
    'stream-json emits init, tool, assistant, and result events'
  );
  const successResult = successEvents.find((event) => event.type === 'result');
  assert.equal(successResult?.is_error, false);
  assert.deepEqual(successResult?.structured_output, { name: 'Ada', age: 30 });
  assert.equal(
    successResult?.total_cost_usd,
    null,
    'unknown model pricing is not reported as free'
  );
  assert.equal(successResult?.cost_unavailable, true);
  assert.equal(
    process.exitCode,
    undefined,
    'successful structured output leaves exit code unchanged'
  );

  process.exitCode = undefined;
  const failureOutput = createWriter();
  const failureAgent = createAgent([
    { toolCalls: [{ name: 'generate_structured', input: { schema, prompt: 'profile' } }] },
    { text: '```json\n{"name":"Ada"}\n```' },
    { text: '```json\n{"age":30}\n```' },
  ]);
  await runOneShot(failureAgent, 'Return a structured profile.', undefined, {
    sessionKey: 'headless-structured-failure',
    outputFormat: 'stream-json',
    stdout: failureOutput.writer,
  });
  const failureEvents = failureOutput.events();
  const failureResult = failureEvents.find((event) => event.type === 'result');
  assert.equal(failureResult?.is_error, true);
  assert.match(failureResult?.error ?? '', /structured output validation failed after 2 attempts/i);
  assert.equal(
    'structured_output' in failureResult,
    false,
    'invalid output never exposes structured data'
  );
  assert.notEqual(process.exitCode, undefined, 'schema failure sets a non-zero process exit code');

  process.exitCode = undefined;
  const pricedOutput = createWriter();
  const pricedAgent = createAgent(
    [
      {
        toolCalls: [{ name: 'generate_structured', input: { schema, prompt: 'profile' } }],
        usage: { inputTokens: 10, outputTokens: 20 },
      },
      {
        text: '```json\n{"name":"Ada","age":30}\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ],
    2,
    'gpt-4o-mini'
  );
  await runOneShot(pricedAgent, 'Return a structured profile.', undefined, {
    sessionKey: 'headless-structured-priced',
    outputFormat: 'stream-json',
    stdout: pricedOutput.writer,
  });
  const pricedResult = pricedOutput.events().find((event) => event.type === 'result');
  assert.equal(pricedResult?.cost_unavailable, false);
  assert.equal(pricedResult?.total_cost_usd, 0.000027);

  const cacheStateOutput = createWriter();
  const cacheAgent = createAgent(
    [
      {
        toolCalls: [{ name: 'generate_structured', input: { schema, prompt: 'profile' } }],
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
      },
      {
        text: '```json\n{"name":"Ada","age":30}\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ],
    2,
    'gpt-4o-mini'
  );
  await runOneShot(cacheAgent, 'Return a structured profile.', undefined, {
    sessionKey: 'headless-structured-cache-cost',
    outputFormat: 'stream-json',
    stdout: cacheStateOutput.writer,
  });
  const cacheResult = cacheStateOutput.events().find((event) => event.type === 'result');
  assert.equal(cacheResult?.total_cost_usd, null, 'cache pricing is not underestimated');
  assert.equal(cacheResult?.cost_unavailable, true);

  console.log('[PASS] headless structured output is parseable and fails closed');
} finally {
  process.exitCode = originalExitCode;
}
