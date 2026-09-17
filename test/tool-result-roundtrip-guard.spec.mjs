import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repairMissingToolResults } from '../dist/core/tools/tool-result-roundtrip-guard.js';

test('preserves mixed user text before the matching tool result', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'example', input: {} }],
      timestamp: 1,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'steer' },
        { type: 'tool_result', tool_use_id: 't1', content: 'REAL' },
      ],
      timestamp: 2,
    },
  ];

  const result = repairMissingToolResults(messages);

  assert.equal(result.changed, false);
  assert.equal(result.insertedCount, 0);
  assert.equal(result.synthesizedToolUseCount, 0);
  assert.deepEqual(result.orphanResultIds, []);
  assert.strictEqual(result.messages, messages);
  assert.deepEqual(result.messages[1].content, [
    { type: 'text', text: 'steer' },
    { type: 'tool_result', tool_use_id: 't1', content: 'REAL' },
  ]);
});
