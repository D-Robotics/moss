#!/usr/bin/env node
/**
 * Per-row projection cache (plan v3 P1). A cached projection must equal a fresh
 * one, a settled row must hit the cache on the next frame, and a width change
 * must miss (the line wrap changes).
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { createProjectionCache } from '../dist/cli/tui/projection-cache.js';
import { renderTranscriptRow } from '../dist/cli/tui/transcript.js';

const rows = Array.from({ length: 2000 }, (_, id) => ({
  id,
  kind: id % 3 === 0 ? 'assistant' : id % 3 === 1 ? 'user' : 'result',
  text: `row ${id} with **bold** words and enough text to wrap across a narrow pane ${id}`,
}));

{
  const cache = createProjectionCache();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const fresh = renderTranscriptRow(row, 40, false, rows[index - 1]);
    const cached = cache.render(row, 40, false, rows[index - 1]);
    assert.deepEqual(cached, fresh, `row ${row.id} projects identically through the cache`);
  }
  assert.equal(cache.stats.misses, rows.length, 'first frame renders every row once');
  for (let index = 0; index < rows.length; index += 1) {
    cache.render(rows[index], 40, false, rows[index - 1]);
  }
  assert.equal(cache.stats.hits, rows.length, 'a settled transcript is served from the cache');
}

{
  const cache = createProjectionCache();
  const row = rows[1];
  cache.render(row, 40, false, undefined);
  const before = cache.stats.misses;
  cache.render(row, 30, false, undefined);
  assert.equal(cache.stats.misses, before + 1, 'a width change re-renders the row');
  cache.render(row, 40, true, undefined);
  assert.equal(cache.stats.misses, before + 2, 'an expanded row is a different projection');
}

{
  // Attachment changes the projection of a result row (no blank line above it).
  const cache = createProjectionCache();
  const tool = {
    id: 10,
    kind: 'tool',
    text: 'List Directory(.)',
    tool: { name: 'list_directory' },
  };
  const result = {
    id: 11,
    kind: 'result',
    text: 'ok · 1ms\n.moss/',
    tool: { name: 'list_directory' },
  };
  const attached = cache.render(result, 60, false, tool);
  const standalone = cache.render(result, 60, false, undefined);
  assert.notDeepEqual(attached, standalone, 'attached and standalone results differ');
  assert.equal(attached[0]?.text.trim() === '' ? 'blank' : 'attached', 'attached');
}

{
  // A frame over 10k rows must stay well inside the budget once warm.
  const many = Array.from({ length: 10_000 }, (_, id) => ({
    id,
    kind: 'assistant',
    text: `answer ${id} with several words to make the projection non-trivial`,
  }));
  const cache = createProjectionCache();
  for (const row of many) cache.render(row, 80, false, undefined);
  const start = performance.now();
  for (const row of many) cache.render(row, 80, false, undefined);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 60, `warm 10k-row projection took ${elapsed.toFixed(1)}ms`);
}
console.log(
  '[PASS] TUI projection cache (identity, hits, width/expand/attach keys, 10k warm budget)'
);
