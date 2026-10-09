#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  THINKING_ONLY_RETRY_BUDGET,
  decidePostLlmAction,
  nextThinkingOnlyRetryAttempts,
} from '../dist/core/loop/agent-loop-post-llm.js';

function thinkingOnly(attempts) {
  return decidePostLlmAction({
    hasThinkingOnly: true,
    toolCallCount: 0,
    postToolThinkingOnlyRetryAttempts: attempts,
    emptyResponseRetryAttempts: 0,
    totalToolCalls: 4,
    streamStopReason: 'end_turn',
    outputContinuationCount: 0,
    maxOutputContinuations: 2,
    missingToolNudgeAttempts: 0,
    finalText: '',
    maxTurns: 80,
    turns: 12,
    shouldNudge: false,
    abortAborted: false,
  });
}

assert.equal(THINKING_ONLY_RETRY_BUDGET, 2);

const first = thinkingOnly(0);
assert.equal(first.kind, 'thinking_retry');
assert.match(first.systemText, /call the next tool/);
assert.equal(nextThinkingOnlyRetryAttempts(first, 0), 1);

const second = thinkingOnly(1);
assert.equal(second.kind, 'thinking_retry');
assert.equal(nextThinkingOnlyRetryAttempts(second, 1), 2);

const stopped = thinkingOnly(THINKING_ONLY_RETRY_BUDGET);
assert.equal(stopped.kind, 'thinking_only_complete');

const visible = decidePostLlmAction({
  hasThinkingOnly: false,
  toolCallCount: 1,
  postToolThinkingOnlyRetryAttempts: 1,
  emptyResponseRetryAttempts: 0,
  totalToolCalls: 4,
  streamStopReason: 'tool_use',
  outputContinuationCount: 0,
  maxOutputContinuations: 2,
  missingToolNudgeAttempts: 0,
  finalText: '',
  maxTurns: 80,
  turns: 13,
  shouldNudge: false,
  abortAborted: false,
});
assert.equal(visible.kind, 'tool_execute');
assert.equal(
  nextThinkingOnlyRetryAttempts(visible, 1),
  0,
  'a later tool call clears the reasoning-only streak'
);

console.log('[PASS] reasoning-only turns retry per streak, then continue the task');
