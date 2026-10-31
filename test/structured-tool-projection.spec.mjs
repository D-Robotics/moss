import assert from 'node:assert/strict';
import test from 'node:test';
import { convertMessagesToPi } from '../dist/core/tools/message-convert.js';

function modelText(content) {
  const messages = [{ role: 'user', timestamp: 0, content: [content] }];
  return convertMessagesToPi(messages, {
    api: 'openai-completions',
    provider: 'test',
    id: 'test',
  })[0].content[0].text;
}

test('stored redacted text is authoritative over old structured content', () => {
  assert.equal(
    modelText({
      type: 'tool_result',
      tool_use_id: '1',
      name: 'fixture',
      content: '[redacted]',
      structuredContent: [{ type: 'text', text: 'synthetic-private-value' }],
    }),
    '[redacted]'
  );
});

test('an intentionally empty result never revives old structured text', () => {
  assert.equal(
    modelText({
      type: 'tool_result',
      tool_use_id: '1',
      name: 'fixture',
      content: '',
      structuredContent: [{ type: 'text', text: 'synthetic-private-value' }],
    }),
    ''
  );
});

test('older structured-only messages remain readable when content is absent', () => {
  assert.equal(
    modelText({
      type: 'tool_result',
      tool_use_id: '1',
      name: 'fixture',
      structuredContent: [{ type: 'text', text: 'legacy evidence' }],
    }),
    'legacy evidence'
  );
});
