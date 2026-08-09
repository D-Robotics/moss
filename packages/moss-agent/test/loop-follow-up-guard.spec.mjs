#!/usr/bin/env node
/**
 * Follow-up guard — pure functions that detect whether the last
 * message needs a tool follow-up, extract thinking tags, and
 * detect unexecuted tool intents in assistant text.
 */
import assert from 'node:assert/strict';
import {
  extractThinkingTagBodies,
  lastMessageNeedsToolFollowUp,
  hasToolResultAfterLastAssistant,
  shouldSuppressReasoningForToolFollowUpRound,
  detectUnexecutedToolIntents,
  DEFAULT_FOLLOW_UP_GUARD_CONFIG,
} from '../dist/core/loop/follow-up-guard.js';

// ─── extractThinkingTagBodies ────────────────────────────────────────────────

{
  assert.equal(extractThinkingTagBodies(''), '', 'empty string returns empty');
  assert.equal(extractThinkingTagBodies(null), '', 'null returns empty');
  assert.equal(extractThinkingTagBodies(undefined), '', 'undefined returns empty');
  assert.equal(extractThinkingTagBodies('   '), '', 'whitespace-only returns empty');
}

{
  const result = extractThinkingTagBodies('<thinking>hello world</thinking>');
  assert.equal(result, 'hello world', 'single thinking tag extracted');
}

{
  const result = extractThinkingTagBodies(
    '<thinking>first</thinking> some text <thinking>second</thinking>'
  );
  assert.equal(result, 'first\nsecond', 'multiple tags joined with newline');
}

{
  const result = extractThinkingTagBodies('<redacted_thinking>secret plan</redacted_thinking>');
  assert.equal(result, 'secret plan', 'redacted_thinking variant extracted');
}

{
  const result = extractThinkingTagBodies('<think>short form</think>');
  assert.equal(result, 'short form', 'think short form extracted');
}

{
  const result = extractThinkingTagBodies('<thinking data-id="123">with attributes</thinking>');
  assert.equal(result, 'with attributes', 'tags with attributes extracted');
}

{
  const result = extractThinkingTagBodies('no tags here');
  assert.equal(result, '', 'no tags returns empty');
}

// ─── lastMessageNeedsToolFollowUp ────────────────────────────────────────────

{
  assert.equal(lastMessageNeedsToolFollowUp([]), false, 'empty array returns false');
}

{
  assert.equal(
    lastMessageNeedsToolFollowUp([{ role: 'assistant', content: 'text' }]),
    false,
    'last message not user returns false'
  );
}

{
  assert.equal(
    lastMessageNeedsToolFollowUp([{ role: 'user', content: 'just text' }]),
    false,
    'user with string content returns false'
  );
}

{
  assert.equal(
    lastMessageNeedsToolFollowUp([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]),
    false,
    'user with only text blocks returns false'
  );
}

{
  assert.equal(
    lastMessageNeedsToolFollowUp([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'result' }],
      },
    ]),
    true,
    'user with tool_result returns true'
  );
}

{
  assert.equal(
    lastMessageNeedsToolFollowUp([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_result', tool_use_id: '1', content: 'data' },
        ],
      },
    ]),
    true,
    'user with mixed blocks including tool_result returns true'
  );
}

// ─── hasToolResultAfterLastAssistant ─────────────────────────────────────────

{
  // Delegates to lastMessageNeedsToolFollowUp
  assert.equal(
    hasToolResultAfterLastAssistant([{ role: 'user', content: 'text' }]),
    false,
    'no tool_result after last assistant'
  );
  assert.equal(
    hasToolResultAfterLastAssistant([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'r' }],
      },
    ]),
    true,
    'tool_result present'
  );
}

// ─── shouldSuppressReasoningForToolFollowUpRound ─────────────────────────────

{
  // Delegates to hasToolResultAfterLastAssistant
  assert.equal(
    shouldSuppressReasoningForToolFollowUpRound([]),
    false,
    'empty messages does not suppress'
  );
  assert.equal(
    shouldSuppressReasoningForToolFollowUpRound([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'r' }],
      },
    ]),
    true,
    'tool follow-up round suppresses reasoning'
  );
}

// ─── detectUnexecutedToolIntents ─────────────────────────────────────────────

{
  // Empty messages
  assert.deepEqual(detectUnexecutedToolIntents([]), [], 'empty messages returns empty');
}

{
  // Last message is not assistant
  assert.deepEqual(
    detectUnexecutedToolIntents([{ role: 'user', content: 'text' }]),
    [],
    'last message not assistant returns empty'
  );
}

{
  // Last assistant has tool_use — no follow-up needed
  assert.deepEqual(
    detectUnexecutedToolIntents([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'exec', input: {} }],
      },
    ]),
    [],
    'assistant with tool_use returns empty'
  );
}

{
  // Assistant describes running a command but doesn't use tool
  const result = detectUnexecutedToolIntents([
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me run the test suite now.' }],
    },
  ]);
  assert.ok(result.length > 0, 'text describing exec fires follow-up');
  assert.equal(result[0].expectedTool, 'exec', 'expected tool is exec');
}

{
  // Assistant describes reading a file but doesn't use tool
  const result = detectUnexecutedToolIntents([
    {
      role: 'assistant',
      content: [{ type: 'text', text: "I'll read the file to check." }],
    },
  ]);
  assert.ok(result.length > 0, 'text describing read fires follow-up');
  assert.equal(result[0].expectedTool, 'read', 'expected tool is read');
}

{
  // Assistant with thinking tags only — should extract from thinking
  const result = detectUnexecutedToolIntents([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '<thinking>I will run the command</thinking>' }],
    },
  ]);
  // stripThinkingTagsKeepVisible removes the thinking content from text,
  // so the text becomes empty; the function then checks thinking bodies
  assert.ok(result.length > 0, 'intent detected from thinking-only content');
}

{
  // Assistant with plain text, no tool intent
  const result = detectUnexecutedToolIntents([
    { role: 'assistant', content: [{ type: 'text', text: 'The result is 42.' }] },
  ]);
  assert.deepEqual(result, [], 'no tool intent in text returns empty');
}

// ─── DEFAULT_FOLLOW_UP_GUARD_CONFIG ──────────────────────────────────────────

{
  assert.equal(DEFAULT_FOLLOW_UP_GUARD_CONFIG.enabled, true, 'enabled by default');
  assert.equal(DEFAULT_FOLLOW_UP_GUARD_CONFIG.maxFollowUps, 1, 'maxFollowUps = 1');
}

console.log('✅ loop-follow-up-guard.spec.mjs — all tests passed');
