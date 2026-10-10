#!/usr/bin/env node
/**
 * Output-limit detection, per-model budgets, and the post-LLM decision order.
 * Truncation (length / max_tokens) is recovered before "reasoning only".
 */
import assert from 'node:assert/strict';
import { decidePostLlmAction } from '../dist/core/loop/agent-loop-post-llm.js';
import {
  escalateOutputTokens,
  resolveModelOutputBudget,
  stitchTruncatedOutput,
} from '../dist/core/loop/output-limit.js';
import { isOutputLimitStopReason, providerStopSignal } from '../dist/provider/output-limit.js';
import { convertStreamEvent, processEvent } from '../dist/provider/pi-ai-stream-parser.js';
import { resolveCliConfig } from '../dist/cli/config.js';
import { resolveCliAgentRuntimeOptions } from '../dist/cli/agent-runtime.js';

assert.equal(isOutputLimitStopReason('length'), true);
assert.equal(isOutputLimitStopReason('max_tokens'), true);
assert.equal(isOutputLimitStopReason('MAX_TOKENS'), true);
assert.equal(isOutputLimitStopReason('max-tokens'), true);
assert.equal(isOutputLimitStopReason('max_output_tokens'), true);
assert.equal(isOutputLimitStopReason('max_completion_tokens'), true);
assert.equal(isOutputLimitStopReason('model_length'), true);
assert.equal(isOutputLimitStopReason('end_turn'), false);
assert.equal(isOutputLimitStopReason('stop'), false);
assert.equal(isOutputLimitStopReason('tool_use'), false);
assert.equal(isOutputLimitStopReason(null), false);
assert.equal(isOutputLimitStopReason(undefined), false);

assert.equal(providerStopSignal('length'), 'length', 'OpenAI finish_reason length');
assert.equal(providerStopSignal('max_tokens'), 'length', 'OpenAI finish_reason max_tokens');
assert.equal(providerStopSignal('max_output_tokens'), 'length');
assert.equal(providerStopSignal('max_tokens'), 'length', 'Anthropic stop_reason max_tokens');
assert.equal(providerStopSignal('end_turn'), 'stop', 'Anthropic stop_reason end_turn');
assert.equal(providerStopSignal('stop'), 'stop');
assert.equal(providerStopSignal('tool_calls'), 'tool_use');
assert.equal(providerStopSignal('tool_use'), 'tool_use');
assert.equal(providerStopSignal('toolCall'), 'tool_use');
assert.equal(providerStopSignal(null), 'stop');
assert.equal(providerStopSignal(''), 'stop');

{
  const content = [];
  const done = processEvent(
    {
      type: 'done',
      stopReason: 'length',
      message: {
        content: [{ type: 'toolCall', id: 't1', name: 'exec', arguments: { command: 'echo hi' } }],
      },
    },
    content,
    (url) => url
  );
  assert.equal(
    done.stopReason,
    'max_tokens',
    'a cutoff stays max_tokens when a tool call is buffered'
  );
  assert.equal(
    content.some((block) => block.type === 'tool_use'),
    true
  );

  const plain = processEvent({ type: 'done', stopReason: 'stop' }, [], (url) => url);
  assert.equal(plain.stopReason, 'end_turn');

  const raw = convertStreamEvent({ type: 'done', stopReason: 'max_tokens' });
  assert.equal(raw?.stopReason, 'max_tokens', 'raw max_tokens is not rewritten to end_turn');
  const anthropic = convertStreamEvent({ type: 'done', reason: 'max_tokens' });
  assert.equal(anthropic?.stopReason, 'max_tokens');
  const toolDone = convertStreamEvent({ type: 'done', stopReason: 'toolUse' });
  assert.equal(toolDone?.stopReason, 'tool_use');
}

{
  const unknown = resolveModelOutputBudget({
    modelId: 'vendor/custom-gateway',
    contextTokens: 1_000_000,
  });
  assert.equal(unknown.initial, 16_384);
  assert.equal(unknown.ceiling, 65_536);

  const glm = resolveModelOutputBudget({ modelId: 'glm-5.3', contextTokens: 1_000_000 });
  assert.equal(glm.initial, 32_768);
  assert.equal(glm.ceiling, 65_536);

  const pinned = resolveModelOutputBudget({
    modelId: 'glm-5.3',
    contextTokens: 1_000_000,
    configured: 8_192,
    pinned: true,
  });
  assert.deepEqual(pinned, { initial: 8_192, ceiling: 8_192 });

  const override = resolveModelOutputBudget({
    modelId: 'glm-5.3',
    contextTokens: 1_000_000,
    configured: 8_192,
    pinned: true,
    overrides: { 'glm-5.3': 100_000 },
  });
  assert.deepEqual(override, { initial: 100_000, ceiling: 100_000 });

  const overrideClamped = resolveModelOutputBudget({
    modelId: 'acme/glm-5.3',
    contextTokens: 32_000,
    overrides: { 'glm-5': 100_000 },
  });
  assert.equal(overrideClamped.initial, 30_976);
  assert.equal(overrideClamped.ceiling, 30_976);

  const modest = resolveModelOutputBudget({ modelId: 'glm-5.3', contextTokens: 32_000 });
  assert.equal(modest.initial, 8_000, 'a 32k window does not start at the full table default');
  assert.ok(modest.ceiling > modest.initial);

  const unpinned = resolveModelOutputBudget({
    modelId: 'glm-5.3',
    contextTokens: 1_000_000,
    configured: 1_024,
    pinned: false,
  });
  assert.equal(unpinned.initial, 1_024, 'an unpinned fixture cap is the first request');
  assert.equal(unpinned.ceiling, 65_536, 'recovery may escalate to the model ceiling');

  assert.equal(escalateOutputTokens(8_192, 65_536), 16_384);
  assert.equal(escalateOutputTokens(16_384, 65_536), 32_768);
  assert.equal(escalateOutputTokens(32_768, 65_536), 65_536);
  assert.equal(escalateOutputTokens(65_536, 65_536), 65_536);
  assert.equal(
    escalateOutputTokens(1_024, 8_000),
    5_120,
    'at least +4096 when doubling is smaller'
  );

  assert.equal(stitchTruncatedOutput('Hello ', 'world'), 'Hello world');
  assert.equal(stitchTruncatedOutput('&&', 'Now'), '&&Now');
  assert.equal(stitchTruncatedOutput('', 'Now'), 'Now');
  assert.equal(stitchTruncatedOutput('&&', ''), '&&');
}

{
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    {
      provider: 'openai',
      model: 'glm-5.3',
      apiKey: 'test-key',
      agent: {
        maxOutputTokens: 9_000,
        models: { 'glm-5.3': { maxOutputTokens: 50_000 } },
      },
    }
  );
  assert.equal(resolved.maxOutputTokens, 9_000);
  assert.equal(resolved.modelMaxOutputTokens?.['glm-5.3'], 50_000);
  const runtime = resolveCliAgentRuntimeOptions(resolved);
  assert.equal(runtime.maxOutputTokensPinned, true);
  assert.equal(runtime.modelMaxOutputTokens?.['glm-5.3'], 50_000);

  const derived = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    {
      provider: 'openai',
      model: 'glm-5.3',
      apiKey: 'test-key',
      agent: { contextTokens: 1_000_000 },
    }
  );
  const derivedRuntime = resolveCliAgentRuntimeOptions(derived);
  assert.equal(derivedRuntime.maxOutputTokensPinned, false);
  assert.equal(derivedRuntime.maxTokens, 32_768);
}

function postLlm(overrides) {
  return decidePostLlmAction({
    hasThinkingOnly: false,
    toolCallCount: 0,
    postToolThinkingOnlyRetryAttempts: 0,
    emptyResponseRetryAttempts: 0,
    totalToolCalls: 0,
    streamStopReason: 'end_turn',
    outputContinuationCount: 0,
    maxOutputContinuations: 3,
    missingToolNudgeAttempts: 0,
    finalText: '',
    maxTurns: 80,
    turns: 1,
    shouldNudge: false,
    abortAborted: false,
    ...overrides,
  });
}

{
  const thinkingCutoff = postLlm({
    hasThinkingOnly: true,
    streamStopReason: 'length',
    finalText: '',
  });
  assert.equal(thinkingCutoff.kind, 'continuation');
  assert.equal(thinkingCutoff.mode, 'thinking');

  const thinkingReal = postLlm({ hasThinkingOnly: true, streamStopReason: 'end_turn' });
  assert.equal(thinkingReal.kind, 'thinking_retry', 'a real reasoning-only turn is not a cutoff');

  const midText = postLlm({ streamStopReason: 'max_tokens', finalText: '&&' });
  assert.equal(midText.kind, 'continuation');
  assert.equal(midText.mode, 'text');

  const partialTool = postLlm({
    streamStopReason: 'length',
    truncatedToolCall: true,
    toolCallCount: 0,
    finalText: '',
  });
  assert.equal(partialTool.kind, 'continuation');
  assert.equal(partialTool.mode, 'tool');

  const exhaustedVisible = postLlm({
    streamStopReason: 'length',
    finalText: 'Now',
    outputContinuationCount: 3,
  });
  assert.equal(
    exhaustedVisible.kind,
    'output_limit_exhausted',
    'a fragment after the recovery cap is not a successful end_turn'
  );

  const exhaustedThinking = postLlm({
    hasThinkingOnly: true,
    streamStopReason: 'max_tokens',
    outputContinuationCount: 3,
  });
  assert.equal(exhaustedThinking.kind, 'output_limit_exhausted');
}

console.log('[PASS] output-limit detection, budgets, and decision order');
