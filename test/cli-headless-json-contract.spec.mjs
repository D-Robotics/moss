#!/usr/bin/env node
/**
 * Headless JSONL embedding contract (`--output-format stream-json`).
 *
 * Locks the public event-stream shape: one JSON object per line, stable
 * event set and field names, result is always terminal. These assertions
 * are the contract — changing an existing field name or event ordering
 * here is a breaking change for embedding hosts.
 */
import assert from 'node:assert/strict';

import { runOneShot } from '../dist/cli/oneshot.js';
import {
  createHeadlessPrintState,
  formatHeadlessStreamEvent,
  formatHeadlessThrownError,
} from '../dist/cli/print.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { MossError, ErrorCode } from '../dist/errors.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

function createWriter() {
  let output = '';
  return {
    writer: {
      write(chunk) {
        output += chunk;
      },
    },
    lines() {
      return output.trim().split('\n').filter(Boolean);
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

// ─── 1. full sequence lock via runOneShot + mock provider ───────────────────

const agent = new MossAgent({
  llmProvider: createMockTranscriptProvider('contract', 'Contract Fixture', [
    {
      toolCalls: [{ name: 'inspect_fixture', input: { target: 'contract' } }],
      usage: { inputTokens: 120, outputTokens: 30 },
    },
    {
      text: 'Fixture inspected; contract sequence complete.',
      usage: { inputTokens: 200, outputTokens: 12 },
    },
  ]),
  sessionStore: new InMemorySessionStore(),
  model: 'contract',
  baseSystemPrompt: 'Use the fixture tool, then answer.',
  domainPrompt: false,
  includeAgentBehaviorPrompt: false,
  enableSteering: false,
  maxAgentTurns: 6,
});

agent.tools.register({
  name: 'inspect_fixture',
  description: 'Inspect the fixture.',
  metadata: { sideEffectClass: 'readonly' },
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return 'fixture value 42';
  },
});

{
  const output = createWriter();
  await runOneShot(agent, 'Inspect the fixture and report the value.', {
    sessionKey: 'headless-json-contract',
    outputFormat: 'stream-json',
    stdout: output.writer,
  });

  const events = output.events();

  // every line is exactly one JSON object (JSONL invariant)
  assert.equal(output.lines().length, events.length, 'one JSON object per line');

  // first event: system/init
  const init = events[0];
  assert.equal(init.type, 'system', 'first event is system');
  assert.equal(init.subtype, 'init', 'first event subtype is init');
  assert.equal(typeof init.session_id, 'string', 'init carries session_id');
  assert.ok(Array.isArray(init.tools), 'init carries the tool list');
  assert.ok(init.tools.includes('inspect_fixture'), 'init lists registered tools');
  assert.equal(typeof init.cwd, 'string', 'init carries cwd');

  // assistant round 1: tool_use block
  const assistant1 = events.find(
    (event) =>
      event.type === 'assistant' && event.message.content.some((b) => b.type === 'tool_use')
  );
  assert.ok(assistant1, 'assistant event with tool_use emitted');
  const toolUse = assistant1.message.content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.name, 'inspect_fixture', 'tool_use carries the tool name');
  assert.deepEqual(toolUse.input, { target: 'contract' }, 'tool_use carries the input');
  assert.equal(typeof toolUse.id, 'string', 'tool_use carries an id');

  // user round: tool_result referencing the call
  const toolResultEvent = events.find((event) => event.type === 'user');
  assert.ok(toolResultEvent, 'user event with tool_result emitted');
  const toolResult = toolResultEvent.message.content[0];
  assert.equal(toolResult.type, 'tool_result', 'user content is tool_result blocks');
  assert.equal(toolResult.tool_use_id, toolUse.id, 'tool_result references the tool_use id');
  assert.equal(toolResult.content, 'fixture value 42', 'tool_result carries the tool output');

  // llm_usage events with snake_case fields
  const usage = events.filter((event) => event.type === 'llm_usage');
  assert.ok(usage.length >= 1, 'llm_usage events emitted');
  assert.equal(usage[0].input_tokens, 120, 'llm_usage input_tokens');
  assert.equal(usage[0].output_tokens, 30, 'llm_usage output_tokens');
  assert.equal(usage[0].session_id, init.session_id, 'llm_usage carries session_id');
  assert.equal(typeof usage[0].ttft_ms, 'number', 'llm_usage carries ttft_ms');
  assert.ok(usage[0].ttft_ms >= 0, 'ttft_ms non-negative');
  assert.equal(typeof usage[0].generation_ms, 'number', 'llm_usage carries generation_ms');

  // final assistant text round
  const finalAssistant = events
    .filter((event) => event.type === 'assistant')
    .find((event) => event.message.content.some((b) => b.type === 'text'));
  assert.ok(finalAssistant, 'assistant text event emitted');

  // terminal event: result, always last
  const result = events[events.length - 1];
  assert.equal(result.type, 'result', 'result is the terminal event');
  assert.equal(result.subtype, 'success', 'successful run subtype');
  assert.equal(result.is_error, false, 'success run is_error false');
  assert.equal(result.session_id, init.session_id, 'result carries session_id');
  assert.equal(typeof result.duration_ms, 'number', 'result carries duration_ms');
  assert.ok(result.num_turns >= 2, 'result counts the turns');
  assert.ok(result.result.includes('contract sequence complete'), 'result carries final text');
}

// ─── 2. unit locks: thinking + compaction + thrown-error terminality ────────

{
  const state = createHeadlessPrintState({ sessionId: 'unit-contract', model: 'm' });
  const emitted = [];
  const push = (agentEvent) => {
    for (const event of formatHeadlessStreamEvent(state, agentEvent)) emitted.push(event);
  };

  push({ type: 'thinking_delta', delta: 'considering ' });
  push({ type: 'thinking_delta', delta: 'the fixture' });
  push({ type: 'text_delta', delta: 'Answer: 42.' });
  const flushed = formatHeadlessStreamEvent(state, { type: 'turn_end', turn: 1 });
  emitted.push(...flushed);

  const assistant = emitted.find((event) => event.type === 'assistant');
  assert.ok(assistant, 'assistant flushed at turn_end');
  assert.deepEqual(
    assistant.message.thinking,
    ['considering ', 'the fixture'],
    'thinking deltas preserved in order'
  );
  assert.equal(assistant.message.content[0].text, 'Answer: 42.', 'visible text preserved');

  const compaction = formatHeadlessStreamEvent(state, {
    type: 'compaction',
    summaryChars: 812,
    droppedMessages: 42,
    tokensBefore: 90_000,
    tokensAfter: 18_000,
    keptToolNames: 5,
  })[0];
  assert.equal(compaction.type, 'compaction', 'compaction event type');
  assert.equal(compaction.summary_chars, 812, 'compaction summary_chars snake_case');
  assert.equal(compaction.dropped_messages, 42, 'compaction dropped_messages snake_case');
  assert.equal(compaction.tokens_before, 90_000, 'compaction tokens_before snake_case');
  assert.equal(compaction.tokens_after, 18_000, 'compaction tokens_after snake_case');
  assert.equal(compaction.kept_tool_names, 5, 'compaction kept_tool_names snake_case');

  const compactionOptional = formatHeadlessStreamEvent(state, {
    type: 'compaction',
    summaryChars: 5,
    droppedMessages: 1,
  })[0];
  assert.equal(
    compactionOptional.tokens_before,
    undefined,
    'optional compaction fields stay absent'
  );

  // thrown error → terminal result event with error details
  const errState = createHeadlessPrintState({ sessionId: 'unit-error' });
  const thrown = formatHeadlessThrownError(
    errState,
    new MossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'gateway exploded' })
  );
  const errResult = thrown[thrown.length - 1];
  assert.equal(errResult.type, 'result', 'thrown error still ends with a result event');
  assert.equal(errResult.is_error, true, 'thrown error result is_error true');
  assert.equal(errResult.subtype, 'error_during_execution', 'thrown error subtype');
  assert.equal(errResult.error_code, ErrorCode.PROVIDER_UPSTREAM_ERROR, 'error_code preserved');
  assert.match(errResult.error, /gateway exploded/, 'error message preserved');
}

console.log('[PASS] cli headless JSONL embedding contract');
