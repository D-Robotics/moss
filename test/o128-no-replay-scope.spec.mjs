// O128 QA point 3: noReplay is set only on read_file; every other read-only
// builtin still goes through the loop's identical-call replay cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtinTools } from '../dist/tools/builtin.js';
import { findLoopReplay } from '../dist/core/loop/agent-loop-tool-execution.js';

const history = (name, input, content) => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
];

test('only read_file is marked noReplay', () => {
  const marked = builtinTools.filter((t) => t.metadata?.noReplay).map((t) => t.name);
  assert.deepEqual(marked, ['read_file']);
});

test('read_file: identical full re-read is never answered from the replay cache', () => {
  const meta = builtinTools.find((t) => t.name === 'read_file').metadata;
  const input = { path: 'src/big.ts' };
  assert.equal(findLoopReplay(history('read_file', input, 'BODY'), 'read_file', input, meta), null);
});

test('every other read-only builtin still replays an identical call', () => {
  const readonly = builtinTools.filter(
    (t) => t.metadata?.sideEffectClass === 'readonly' && t.name !== 'read_file'
  );
  assert.ok(readonly.length > 0);
  for (const t of readonly) {
    const input = { pattern: 'foo', path: 'src', query: 'q' };
    assert.equal(
      findLoopReplay(history(t.name, input, `RESULT-${t.name}`), t.name, input, t.metadata),
      `RESULT-${t.name}`,
      `${t.name} still replays`
    );
  }
});
