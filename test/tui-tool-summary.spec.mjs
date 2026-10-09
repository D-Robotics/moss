#!/usr/bin/env node
/**
 * Semantic tool headlines (plan v3 P3): every read-only observation names what
 * came back, not just `ok`. Red-first: these cases failed before the listing,
 * search and fetch summaries existed.
 */
import assert from 'node:assert/strict';

import { summarizeToolCompletion } from '../dist/cli/tui/tool-summary.js';

const listing = summarizeToolCompletion('list_directory', { path: '.' }, 'a.ts\nb.ts\nsrc/', false);
assert.equal(listing.summary, 'Listed 3 entries', 'a directory listing counts its entries');

const single = summarizeToolCompletion('list_directory', { path: '.moss' }, '.moss/', false);
assert.equal(single.summary, 'Listed 1 entry', 'singular when there is one entry');

const empty = summarizeToolCompletion('list_directory', { path: 'empty' }, '', false);
assert.equal(empty.summary, 'Listed 0 entries', 'an empty directory says so');

const search = summarizeToolCompletion(
  'search_code',
  { pattern: 'foo' },
  'a.ts:1: foo\nb.ts:9: foo()\nc.ts:3: foo',
  false
);
assert.equal(search.summary, 'Found 3 matches', 'a code search counts matches');

const none = summarizeToolCompletion('search_code', { pattern: 'zzz' }, '', false);
assert.equal(none.summary, 'No matches', 'an empty search says there were no matches');

const fetched = summarizeToolCompletion(
  'web_fetch',
  { url: 'https://docs.example.com/page?x=1' },
  'page body',
  false
);
assert.equal(fetched.summary, 'Fetched docs.example.com', 'a fetch names the host, not the path');

const failed = summarizeToolCompletion('list_directory', { path: 'nope' }, 'ENOENT', true);
assert.match(failed.summary ?? '', /^failed/, 'errors keep the failure headline');
console.log('[PASS] TUI semantic tool headlines (listing, search, fetch, errors)');

// P3: folded output is advertised from the hint row, and only while it is folded.
{
  const { renderHint } = await import('../dist/cli/tui/transcript.js');
  const base = { running: false, tokens: 0, taskCount: 0, queueLength: 0 };
  const folded = renderHint({ ...base, collapsed: true }, 120).text;
  assert.ok(folded.includes('ctrl+o to expand'), 'a folded result is advertised');
  const plain = renderHint(base, 120).text;
  assert.ok(!plain.includes('ctrl+o to expand'), 'nothing folded, nothing advertised');
  const narrow = renderHint({ ...base, collapsed: true }, 40).text;
  assert.ok(narrow.includes('full mode on'), 'the mode label still wins on a narrow pane');
}

// Exec headlines (live capture): the last output line is used only when it reads
// as a conclusion. A directory listing ending in `n...` must say how big it was.
{
  const listing = Array.from({ length: 40 }, (_, index) => `file-${index}.txt`)
    .concat(['n...'])
    .join('\n');
  const listed = summarizeToolCompletion('exec', { command: 'ls' }, listing, false);
  assert.ok(
    listed.summary && !/^n\.\.\./.test(listed.summary),
    `a listing is not headlined by its last entry: ${listed.summary}`
  );
  assert.match(listed.summary ?? '', /41 lines/, 'the headline counts the lines instead');

  const built = summarizeToolCompletion(
    'exec',
    { command: 'npm run build' },
    'compiling\n'.repeat(12) + 'Build succeeded in 3.2s',
    false
  );
  assert.equal(built.summary, 'Build succeeded in 3.2s', 'a conclusion line is kept');

  const tests = summarizeToolCompletion(
    'exec',
    { command: 'npm test' },
    'running\n'.repeat(12) + 'Tests: 12 passed, 0 failed',
    false
  );
  assert.equal(tests.summary, 'Tests: 12 passed, 0 failed', 'a test verdict is kept');
}
