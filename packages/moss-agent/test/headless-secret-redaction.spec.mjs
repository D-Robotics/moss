#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createHeadlessPrintState,
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
