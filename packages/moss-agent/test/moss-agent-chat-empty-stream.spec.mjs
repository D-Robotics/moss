#!/usr/bin/env node
/**
 * Regression tests for MossAgent.chat() stream termination semantics.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/moss-agent-chat-empty-stream.spec.mjs
 */

import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/index.js';
import { MossError, ErrorCode } from '../dist/errors.js';

async function callChatWithStream(streamFactory) {
  return MossAgent.prototype.chat.call(
    { streamChat: streamFactory },
    'test-session',
    'hello',
  );
}

{
  await assert.rejects(
    () => callChatWithStream(async function* () {
      // Empty stream: no done and no error event.
    }),
    (err) => {
      assert.ok(err instanceof MossError);
      assert.equal(err.code, ErrorCode.INTERNAL_INVARIANT_VIOLATED);
      assert.match(err.message, /ended without done or error/i);
      return true;
    },
  );
  console.log('[PASS] chat() rejects when stream ends without done or error');
}

{
  let drainedAfterError = false;
  await assert.rejects(
    () => callChatWithStream(async function* () {
      yield { type: 'error', error: 'provider failed after partial stream', retriable: false };
      drainedAfterError = true;
      yield { type: 'error', error: 'later cleanup error', retriable: false };
      yield {
        type: 'done',
        result: {
          response: 'stale success',
          toolCalls: [],
          toolResults: [],
          stopReason: 'end_turn',
        },
      };
    }),
    (err) => {
      assert.ok(err instanceof MossError);
      assert.equal(err.code, ErrorCode.INTERNAL_INVARIANT_VIOLATED);
      assert.match(err.message, /provider failed/);
      assert.doesNotMatch(err.message, /later cleanup error/);
      return true;
    },
  );
  assert.equal(drainedAfterError, true, 'chat() must drain after error so stream teardown can run');
  console.log('[PASS] chat() drains after error while preserving error precedence');
}

{
  await assert.rejects(
    () => callChatWithStream(async function* () {
      yield {
        type: 'error',
        error: {
          role: 'assistant',
          errorMessage: 'real provider failure',
          stopReason: 'error',
          content: [],
        },
        retriable: false,
      };
    }),
    (err) => {
      assert.ok(err instanceof MossError);
      assert.equal(err.code, ErrorCode.INTERNAL_INVARIANT_VIOLATED);
      assert.match(err.message, /real provider failure/);
      assert.notEqual(err.message, '[object Object]');
      return true;
    },
  );
  console.log('[PASS] chat() formats object error events readably');
}

console.log('[PASS] MossAgent.chat empty/error stream regressions');
