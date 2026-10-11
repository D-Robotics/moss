#!/usr/bin/env node
// O13: a thinking-only turn (glm-5.3 self run1) must be recovered, not abort the run.
// Simulates the model's responses at the decision layer: no live model needed.
import assert from 'node:assert/strict';
import {
  THINKING_ONLY_RETRY_BUDGET,
  decidePostLlmAction,
  nextThinkingOnlyRetryAttempts,
  thinkingOnlyReasoningOverride,
} from '../dist/core/loop/agent-loop-post-llm.js';

function ctx(over) {
  return {
    hasThinkingOnly: true,
    toolCallCount: 0,
    postToolThinkingOnlyRetryAttempts: 0,
    emptyResponseRetryAttempts: 0,
    totalToolCalls: 7,
    streamStopReason: 'stop',
    outputContinuationCount: 0,
    maxOutputContinuations: 2,
    missingToolNudgeAttempts: 0,
    finalText: '',
    maxTurns: 50,
    turns: 9,
    shouldNudge: false,
    abortAborted: false,
    provider: 'openai-compatible',
    modelId: 'glm-5.3',
    ...over,
  };
}

// Replays a scripted sequence of turn kinds; returns how the run ends.
function replay(script) {
  let attempts = 0;
  const overrides = [];
  for (const turn of script) {
    const action = decidePostLlmAction(
      ctx({
        hasThinkingOnly: turn === 'thinking',
        toolCallCount: turn === 'tool' ? 1 : 0,
        finalText: turn === 'answer' ? 'done' : '',
        postToolThinkingOnlyRetryAttempts: attempts,
      })
    );
    attempts = nextThinkingOnlyRetryAttempts(action, attempts);
    if (action.kind === 'thinking_retry') overrides.push(action.reasoningOverride);
    if (action.kind === 'thinking_only_complete') return { aborted: true, overrides };
    if (action.kind === 'steering_or_complete') return { aborted: false, overrides };
  }
  return { aborted: false, overrides };
}

// run1 shape: two consecutive thinking-only turns. Before O13 this aborted.
const run1 = replay(['tool', 'thinking', 'thinking', 'tool', 'answer']);
assert.equal(run1.aborted, false, 'two thinking-only turns in a row must not abort');
assert.deepEqual(
  run1.overrides,
  ['low', 'off'],
  'glm: first retry lowers reasoning, second turns it off'
);

// Acceptance proxy: "3 runs" with thinking-only bursts at different points.
for (const script of [
  ['thinking', 'answer'],
  ['tool', 'thinking', 'tool', 'thinking', 'thinking', 'answer'],
  ['tool', 'tool', 'thinking', 'thinking', 'answer'],
]) {
  assert.equal(replay(script).aborted, false, `aborted on ${script.join(',')}`);
}

// Counter resets after a productive turn.
assert.equal(nextThinkingOnlyRetryAttempts({ kind: 'tool_execute' }, 2), 0);

// Bounded: a model that never acts still stops (no infinite loop).
const stuck = replay(Array(THINKING_ONLY_RETRY_BUDGET + 2).fill('thinking'));
assert.equal(stuck.aborted, true);

// Per provider: a model that cannot turn reasoning off only gets 'low'.
assert.equal(thinkingOnlyReasoningOverride('anthropic', 1, 'claude-sonnet-4-5'), 'low');
assert.equal(thinkingOnlyReasoningOverride('openai-compatible', 1, 'glm-5.3'), 'off');
assert.equal(thinkingOnlyReasoningOverride('deepseek', 1, 'deepseek-reasoner'), 'off');
assert.equal(thinkingOnlyReasoningOverride('anyone', 0, 'glm-5.3'), 'low');

// The nudge text still steers toward a tool call mid-task.
const first = decidePostLlmAction(ctx({}));
assert.equal(first.kind, 'thinking_retry');
assert.match(first.systemText, /call the next tool/);

console.log('o13-thinking-only-recovery: ok');
