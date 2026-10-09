#!/usr/bin/env node
/**
 * Old large tool results shrink. The pending batch after the last assistant
 * message, and results under the size floor, stay intact. A second pass does
 * not rewrite a stub.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TOOL_RESULT_ELIDED_MARKER,
  elideOldLargeToolResults,
} from '../dist/context/tool-result-elision.js';

function message(role, content) {
  return { role, content, timestamp: 1 };
}

function toolResult(id, text) {
  return message('user', [
    { type: 'tool_result', tool_use_id: id, name: 'read_file', content: text },
  ]);
}

function textOf(messages, id) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id === id) return block.content;
    }
  }
  return undefined;
}

test('old large tool results shrink; pending and recall-sized results stay', () => {
  const old1 = `OLD1\n${'x'.repeat(9000)}`;
  const old2 = `OLD2\n${'y'.repeat(9000)}`;
  const old3 = `OLD3\n${'z'.repeat(9000)}`;
  const old4 = `OLD4\n${'w'.repeat(9000)}`;
  const recallSized = `fact\n${'n'.repeat(5300)}`;
  const pending = `PENDING\n${'p'.repeat(9000)}`;
  const messages = [
    message('user', 'start'),
    message('assistant', 'a1'),
    toolResult('1', old1),
    message('assistant', 'a2'),
    toolResult('2', old2),
    message('assistant', 'a3'),
    toolResult('3', old3),
    message('assistant', 'a4'),
    toolResult('4', old4),
    message('assistant', 'a5'),
    toolResult('5', recallSized),
    message('assistant', 'calling tools'),
    toolResult('6', pending),
  ];

  const first = elideOldLargeToolResults(messages);
  assert.equal(first.elidedCount, 1);
  assert.ok(first.savedChars > 0);
  const stub = textOf(first.messages, '1');
  assert.equal(typeof stub, 'string');
  assert.ok(stub.includes(TOOL_RESULT_ELIDED_MARKER));
  assert.ok(stub.length < old1.length);
  assert.equal(textOf(first.messages, '2'), old2);
  assert.equal(textOf(first.messages, '3'), old3);
  assert.equal(textOf(first.messages, '4'), old4);
  assert.equal(textOf(first.messages, '5'), recallSized);
  assert.equal(textOf(first.messages, '6'), pending);

  const second = elideOldLargeToolResults(first.messages);
  assert.equal(second.elidedCount, 0);
  assert.equal(second.savedChars, 0);
  assert.equal(textOf(second.messages, '1'), stub);
});
