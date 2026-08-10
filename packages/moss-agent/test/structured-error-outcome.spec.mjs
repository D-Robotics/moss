#!/usr/bin/env node
import assert from 'node:assert/strict';

import { runOneShot } from '../dist/cli/oneshot.js';
import { ExitCode } from '../dist/cli/exit-codes.js';
import { providerError } from '../dist/cli/providers.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { ErrorCode, MossError } from '../dist/errors.js';

function createAuthFailAgent({ code = ErrorCode.PROVIDER_AUTH_FAILED, recoverable = false } = {}) {
  return new MossAgent({
    llmProvider: {
      id: 'auth-fail',
      displayName: 'Auth fail',
      async complete() {
        throw new Error('not used');
      },
      async stream() {
        throw new MossError({
          code,
          message: 'Provider rejected the API key.',
          hint: 'Run moss setup.',
          recoverable,
        });
      },
    },
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxLLMRetries: 0,
  });
}

{
  const agent = createAuthFailAgent({ code: ErrorCode.PROVIDER_RATE_LIMITED, recoverable: true });
  const events = [];
  for await (const event of agent.streamChat('recoverable-stream', 'hello')) events.push(event);
  const error = events.find((event) => event.type === 'error');
  assert.equal(error?.errorDetails?.recoverable, true);
  assert.equal(error?.retriable, true);
}

{
  const agent = createAuthFailAgent();
  const events = [];
  for await (const event of agent.streamChat('structured-stream', 'hello')) events.push(event);
  const error = events.find((event) => event.type === 'error');
  assert.equal(error?.errorDetails?.code, ErrorCode.PROVIDER_AUTH_FAILED);
  assert.equal(error?.errorDetails?.recoverable, false);
  assert.equal(error?.retriable, false);

  await assert.rejects(
    () => agent.chat('structured-chat', 'hello'),
    (err) => err instanceof MossError && err.code === ErrorCode.PROVIDER_AUTH_FAILED,
    'chat() rethrows the original structured classification'
  );
}

{
  const originalExitCode = process.exitCode;
  let output = '';
  try {
    process.exitCode = undefined;
    await runOneShot(createAuthFailAgent(), 'hello', undefined, {
      sessionKey: 'structured-oneshot',
      outputFormat: 'stream-json',
      stdout: {
        write(chunk) {
          output += chunk;
        },
      },
    });
    assert.equal(process.exitCode, ExitCode.PROVIDER_AUTH);
    const result = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'result');
    assert.equal(result?.error_code, ErrorCode.PROVIDER_AUTH_FAILED);
    assert.equal(result?.recoverable, false);
  } finally {
    process.exitCode = originalExitCode;
  }
}

for (const [status, code] of [
  [401, ErrorCode.PROVIDER_AUTH_FAILED],
  [429, ErrorCode.PROVIDER_RATE_LIMITED],
  [500, ErrorCode.PROVIDER_UPSTREAM_ERROR],
]) {
  const error = providerError('test', status, JSON.stringify({ error: { message: 'rejected' } }));
  assert.ok(error instanceof MossError);
  assert.equal(error.code, code);
}

console.log('[PASS] structured error outcome survives stream, embedding, and CLI adapters');
