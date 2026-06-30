/**
 * Steering engine — built-in rules, focused on the web-search-variation rule
 * that catches the "synonym re-search" anti-pattern (multiple web_search calls
 * with different queries in one turn).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SteeringEngine,
  DEFAULT_STEERING_RULES,
  BUILTIN_WEB_SEARCH_VARIATION_RULE,
} from '../dist/core/loop/steering.js';

/** Build an assistant message containing a single tool_use block. */
function assistantToolUse(name, input, id = '1') {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

/** Build a user message with a tool_result (keeps the conversation shape real). */
function toolResult(id = '1') {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
  };
}

function baseCtx(messages) {
  return {
    messages,
    turn: 3,
    consecutiveToolErrors: 0,
    totalToolCalls: messages.filter((m) => m.role === 'assistant').length,
    contextUsageRatio: 0.1,
    sessionKey: 'test',
  };
}

test('BUILTIN_WEB_SEARCH_VARIATION_RULE fires on 3 different web_search queries', () => {
  const messages = [
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '1'),
    toolResult('1'),
    assistantToolUse('web_search', { query: 'RDK S600 旭日 开发板 购买' }, '2'),
    toolResult('2'),
    assistantToolUse('web_search', { query: 'RDK S600 价格 立创' }, '3'),
    toolResult('3'),
  ];
  const guidance = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(baseCtx(messages));
  assert.ok(guidance, 'rule should fire when 3 distinct queries exist');
  assert.match(guidance, /3 different queries/);
  assert.match(guidance, /web_fetch/);
});

test('BUILTIN_WEB_SEARCH_VARIATION_RULE does not fire on a single web_search', () => {
  const messages = [
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '1'),
    toolResult('1'),
  ];
  const guidance = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(baseCtx(messages));
  assert.equal(guidance, null);
});

test('BUILTIN_WEB_SEARCH_VARIATION_RULE ignores non-web_search tools', () => {
  const messages = [
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '1'),
    toolResult('1'),
    assistantToolUse('read_file', { path: '/tmp/x' }, '2'),
    toolResult('2'),
  ];
  const guidance = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(baseCtx(messages));
  assert.equal(guidance, null, 'read_file should not count toward web_search variation');
});

test('BUILTIN_WEB_SEARCH_VARIATION_RULE does not fire on identical queries', () => {
  const messages = [
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '1'),
    toolResult('1'),
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '2'),
    toolResult('2'),
  ];
  const guidance = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(baseCtx(messages));
  assert.equal(
    guidance,
    null,
    'identical queries collapse to 1 distinct — rule should not fire'
  );
});

test('BUILTIN_WEB_SEARCH_VARIATION_RULE is case/whitespace insensitive', () => {
  const messages = [
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '1'),
    toolResult('1'),
    assistantToolUse('web_search', { query: '  rdk s600 购买  ' }, '2'),
    toolResult('2'),
  ];
  const guidance = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(baseCtx(messages));
  assert.equal(guidance, null, 'same query differing only in case/whitespace = 1 distinct');
});

test('DEFAULT_STEERING_RULES includes the web-search-variation rule', () => {
  const ids = DEFAULT_STEERING_RULES.map((r) => r.id);
  assert.ok(ids.includes('web-search-variation'));
});

test('SteeringEngine fires web-search-variation after 3 distinct searches', () => {
  const engine = new SteeringEngine();
  const messages = [
    assistantToolUse('web_search', { query: 'RDK S600 购买' }, '1'),
    toolResult('1'),
    assistantToolUse('web_search', { query: 'RDK S600 价格 立创' }, '2'),
    toolResult('2'),
    assistantToolUse('web_search', { query: 'RDK S600 旭日 开发板' }, '3'),
    toolResult('3'),
  ];
  const result = engine.evaluate(baseCtx(messages));
  assert.ok(result.triggered);
  assert.ok(result.firedRules.includes('web-search-variation'));
});

test('SteeringEngine respects cooldown for web-search-variation', () => {
  const engine = new SteeringEngine();
  const messages = [
    assistantToolUse('web_search', { query: 'a' }, '1'),
    toolResult('1'),
    assistantToolUse('web_search', { query: 'b' }, '2'),
    toolResult('2'),
    assistantToolUse('web_search', { query: 'c' }, '3'),
    toolResult('3'),
  ];
  // turn 3: fires
  const r1 = engine.evaluate({ ...baseCtx(messages), turn: 3 });
  assert.ok(r1.firedRules.includes('web-search-variation'));
  // turn 4: within cooldown (5) — should not fire again
  const r2 = engine.evaluate({ ...baseCtx(messages), turn: 4 });
  assert.ok(!r2.firedRules.includes('web-search-variation'));
});
