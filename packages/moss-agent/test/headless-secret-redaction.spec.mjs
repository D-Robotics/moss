#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createHeadlessPrintState,
  formatHeadlessSkillCompositionEvent,
  formatHeadlessStreamEvent,
} from '../dist/cli/print.js';

const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuv'].join('-');
const state = createHeadlessPrintState({ sessionId: 'secret-test', model: 'test' });

formatHeadlessStreamEvent(state, { type: 'text_delta', delta: `answer ${secret}` });
formatHeadlessStreamEvent(state, {
  type: 'tool_start',
  toolName: 'exec',
  toolCallId: 't1',
  input: { command: `curl -H "Authorization: Bearer ${secret}"` },
});
const toolEvents = formatHeadlessStreamEvent(state, {
  type: 'tool_end',
  toolName: 'exec',
  toolCallId: 't1',
  result: `failed token=${secret}`,
  isError: true,
  structuredContent: [{ type: 'text', text: secret }],
});
const toolJson = JSON.stringify(toolEvents);
assert.ok(!toolJson.includes(secret), 'stream-json assistant input and tool result are redacted');
assert.match(toolJson, /REDACTED|\*\*\*/, 'stream-json retains a redaction marker');

formatHeadlessStreamEvent(state, { type: 'error', error: `provider rejected ${secret}`, retriable: false });
const resultEvents = formatHeadlessStreamEvent(state, {
  type: 'done',
  result: {
    response: `final ${secret}`,
    toolCalls: [],
    toolResults: [],
    stopReason: 'error',
  },
});
const resultJson = JSON.stringify(resultEvents);
assert.ok(!resultJson.includes(secret), 'final result and error are redacted');

const compositionEvent = formatHeadlessSkillCompositionEvent({
  sessionId: 'secret-test',
  kind: 'active',
  trace: {
    provider: 'fallback',
    candidateScores: [],
    finalOrder: [],
    finalNames: [],
    cardinality: 0,
    rejected: true,
    fallbackReason: `provider rejected ${secret}`,
    injectedChars: 0,
  },
});
assert.equal(compositionEvent.type, 'skill_composition');
assert.ok(!JSON.stringify(compositionEvent).includes(secret), 'composition event redacts secrets');

console.log('[PASS] headless JSON redacts assistant, tool, structured, and error secrets');

const structuredState = createHeadlessPrintState({ sessionId: 'structured-test', model: 'test' });
formatHeadlessStreamEvent(structuredState, {
  type: 'tool_start',
  toolName: 'generate_structured',
  toolCallId: 'structured-1',
  input: { schema: { type: 'object' }, prompt: 'profile' },
});
formatHeadlessStreamEvent(structuredState, {
  type: 'tool_end',
  toolName: 'generate_structured',
  toolCallId: 'structured-1',
  result: '[generate_structured: ready]',
});
formatHeadlessStreamEvent(structuredState, {
  type: 'text_delta',
  delta: '```json\n{"name":"Ada","age":30}\n```',
});
const structuredEvents = formatHeadlessStreamEvent(structuredState, {
  type: 'done',
  result: {
    response: '```json\n{"name":"Ada","age":30}\n```',
    toolCalls: [{ id: 'structured-1', name: 'generate_structured', input: {} }],
    toolResults: [],
    stopReason: 'end_turn',
  },
});
const structuredResult = structuredEvents.find((event) => event.type === 'result');
assert.deepEqual(
  structuredResult?.structured_output,
  { name: 'Ada', age: 30 },
  'headless success exposes parsed structured output without removing the raw result',
);

console.log('[PASS] headless JSON exposes machine-readable structured output');

const telemetryState = createHeadlessPrintState({ sessionId: 'telemetry-test', model: 'test' });
assert.deepEqual(
  formatHeadlessStreamEvent(telemetryState, {
    type: 'llm_usage',
    inputTokens: 1200,
    outputTokens: 30,
    cacheReadTokens: 900,
    cacheCreationTokens: 100,
    contextTokens: 128000,
  }),
  [{
    type: 'llm_usage',
    session_id: 'telemetry-test',
    input_tokens: 1200,
    output_tokens: 30,
    cache_read_tokens: 900,
    cache_creation_tokens: 100,
    context_tokens: 128000,
  }],
);
assert.deepEqual(
  formatHeadlessStreamEvent(telemetryState, {
    type: 'cache_metrics',
    promptCacheEnabled: true,
    promptCacheDebug: true,
    stableChars: 8200,
    dynamicChars: 420,
    eligible: true,
    eligibilityReason: 'eligible',
    minStableChars: 2048,
    maxDynamicCharsRatio: 0.25,
    prefixChecks: 1,
    prefixChanges: 0,
    toolOrderChecks: 1,
    toolOrderChanges: 0,
    cacheReadTokens: 900,
    cacheCreationTokens: 100,
  }),
  [{
    type: 'cache_metrics',
    session_id: 'telemetry-test',
    prompt_cache_enabled: true,
    prompt_cache_debug: true,
    stable_chars: 8200,
    dynamic_chars: 420,
    eligible: true,
    eligibility_reason: 'eligible',
    cache_read_tokens: 900,
    cache_creation_tokens: 100,
  }],
);

console.log('[PASS] headless JSON preserves usage and prompt-cache telemetry');
