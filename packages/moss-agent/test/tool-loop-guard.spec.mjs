/**
 * Tool loop guard — per-URL failure tracking for web_fetch.
 *
 * Regression spec for the scenario where a batch of unrelated fetch failures
 * (a 401 on Reuters, `fetch failed` on TechCrunch) poisoned the tool-level
 * failure counter and blocked a subsequent batch of *different* RSS URLs.
 * web_fetch failures must be tracked per-URL: only a single URL failing
 * repeatedly counts toward blocking that URL; other hosts stay unaffected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createToolLoopGuardState,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  formatToolLoopGuardMessage,
} from '../dist/core/tools/tool-loop-guard.js';

const failureLimit = 3; // DEFAULT_TOOL_FAILURE_LIMIT

// A soft failure text shaped exactly like web-fetch.ts emits for a 401/403,
// so recordToolLoopOutcome's isSoftToolFailureResult path is exercised.
const SOFT_401 = 'web_fetch_error: HTTP 401 Unauthorized — https://reuters.example/x';

test('edit_file: repeated failures on same path short-circuit even with different old_string', () => {
  const state = createToolLoopGuardState();
  const path = 'src/auth.ts';
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(
      state,
      'edit_file',
      true,
      `Error: old_string not found in ${path}.`,
      { path, old_string: `attempt-${i}`, new_string: 'fixed' },
    );
  }
  const blocked = shouldShortCircuitToolCall(state, 'edit_file', {
    path,
    old_string: 'yet-another-try',
    new_string: 'fixed',
  });
  assert.ok(blocked, 'third failed edit on same path blocks further thrash');
  assert.match(blocked, /edit thrash on src\/auth\.ts/i);
  const msg = formatToolLoopGuardMessage(blocked, 'edit_file');
  assert.match(msg, /read_file/i, 'message steers model to re-read');
  // Other paths remain editable
  assert.equal(
    shouldShortCircuitToolCall(state, 'edit_file', {
      path: 'src/other.ts',
      old_string: 'x',
      new_string: 'y',
    }),
    null,
    'failures on one path do not block edits elsewhere',
  );
});

test('apply_patch: repeated failures on same path short-circuit thrash', () => {
  const state = createToolLoopGuardState();
  const patchBody = (n) =>
    `*** Begin Patch\n*** Update File: src/auth.ts\n@@\n-old${n}\n+new\n*** End Patch`;
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'apply_patch', true, 'Patch rejected for src/auth.ts: mismatch', {
      patch: patchBody(i),
    });
  }
  const blocked = shouldShortCircuitToolCall(state, 'apply_patch', {
    patch: patchBody(99),
  });
  assert.ok(blocked, 'third failed patch on same path blocks further thrash');
  assert.match(blocked, /edit thrash on src\/auth\.ts/i);
});

test('web_fetch: different failing URLs do not poison each other', () => {
  const state = createToolLoopGuardState();

  // Three different hosts all fail.
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: 'https://techcrunch.example/a' });
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: 'https://robohub.example/b' });
  recordToolLoopOutcome(state, 'web_fetch', true, SOFT_401, { url: 'https://reuters.example/x' });

  // A brand-new URL that has never failed must NOT be short-circuited.
  const blocked = shouldShortCircuitToolCall(state, 'web_fetch', { url: 'https://spectrum.ieee.org/rss' });
  assert.equal(blocked, null, 'a fresh URL is not blocked by other hosts failing');

  // And the tool-level byToolFailure counter must not have been bumped for web_fetch.
  assert.equal(state.byToolFailure.get('web_fetch'), undefined, 'web_fetch failures stay per-URL, not tool-level');
});

test('web_fetch: a single URL failing repeatedly hits the limit and is blocked', () => {
  const state = createToolLoopGuardState();
  const url = 'https://broken.example/feed';

  for (let i = 0; i < failureLimit; i++) {
    recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url });
  }

  const blocked = shouldShortCircuitToolCall(state, 'web_fetch', { url });
  assert.ok(blocked, 'the same URL failing N times is blocked');
  assert.match(blocked, /web_fetch on .+ has failed 3 time\(s\)/);
  // Other URLs are still fine.
  assert.equal(
    shouldShortCircuitToolCall(state, 'web_fetch', { url: 'https://other.example/feed' }),
    null,
    'only the repeated-failure URL is blocked'
  );
});

test('web_fetch: the per-URL block message tells the model to drop THIS url, not the whole tool', () => {
  const state = createToolLoopGuardState();
  const url = 'https://broken.example/feed';
  for (let i = 0; i < failureLimit; i++) {
    recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url });
  }
  const reason = shouldShortCircuitToolCall(state, 'web_fetch', { url });
  assert.ok(reason);
  const msg = formatToolLoopGuardMessage(reason, 'web_fetch');
  // Must NOT carry the tool-level "STOP calling it / Do NOT keep trying variations"
  // instruction — that would wrongly forbid switching to a different URL.
  assert.doesNotMatch(msg, /STOP calling it/i, 'per-URL block must not forbid the whole tool');
  assert.match(msg, /This specific URL/i, 'per-URL block scopes the stop to this URL');
  assert.match(msg, /may web_fetch a different source/i, 'per-URL block allows switching sources');
});

test('web_fetch: successes do not count toward the URL failure counter', () => {
  const state = createToolLoopGuardState();
  // A success followed by two failures on the same URL: only the failures count.
  recordToolLoopOutcome(state, 'web_fetch', false, 'source: ...\nhttp_ok: true\n...', { url: 'https://flaky.example/feed' });
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: 'https://flaky.example/feed' });
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: 'https://flaky.example/feed' });

  assert.equal(
    shouldShortCircuitToolCall(state, 'web_fetch', { url: 'https://flaky.example/feed' }),
    null,
    'two failures (not three) do not hit the limit'
  );
});

test('web_fetch: URL normalization collapses trivial variations', () => {
  const state = createToolLoopGuardState();
  const base = 'https://broken.example/feed';
  // Three calls that differ only by fragment / trailing slash / case-of-hash.
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: `${base}` });
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: `${base}/` });
  recordToolLoopOutcome(state, 'web_fetch', true, 'Execution error: fetch failed', { url: `${base}#section` });

  const blocked = shouldShortCircuitToolCall(state, 'web_fetch', { url: `${base}#other` });
  assert.ok(blocked, 'fragment/trailing-slash variations count as the same URL');
});

test('other tools: unchanged — still use the tool-level failure counter', () => {
  const state = createToolLoopGuardState();
  // A non-web_fetch tool failing three times must still be blocked (regression
  // guard that the web_fetch branch didn't accidentally bypass other tools).
  for (let i = 0; i < failureLimit; i++) {
    recordToolLoopOutcome(state, 'some_tool', true, 'Execution error: boom', { x: i });
  }
  const blocked = shouldShortCircuitToolCall(state, 'some_tool', { x: 99 });
  assert.ok(blocked, 'non-web_fetch tools still hit the tool-level failure limit');
  assert.match(blocked, /some_tool has failed 3 time\(s\)/);
});

test('dated RSS news evidence suppresses follow-up search expansion', () => {
  const state = createToolLoopGuardState();
  const first = shouldShortCircuitToolCall(state, 'web_search', { query: 'robotics news', recency: 'day' });
  assert.equal(first, null);

  recordToolLoopOutcome(
    state,
    'web_search',
    false,
    'Found 3 results\n\nRSS news snapshot: dated publisher/feed summaries above are sufficient to answer a low-risk news overview directly.',
    { query: 'robotics news', recency: 'day' },
  );

  const blocked = shouldShortCircuitToolCall(state, 'web_search', { query: 'humanoid robot announcement' });
  assert.match(blocked, /dated RSS news snapshot/i);
  assert.match(formatToolLoopGuardMessage(blocked, 'web_search'), /answer now/i);
});

test('only one fresh-news search starts in the same assistant batch', () => {
  const state = createToolLoopGuardState();
  assert.equal(
    shouldShortCircuitToolCall(state, 'web_search', { query: 'robotics news', recency: 'day' }),
    null,
  );
  const blocked = shouldShortCircuitToolCall(state, 'web_search', { query: '机器人 新闻', recency: 'day' });
  assert.match(blocked, /fresh-news search is already in progress/i);
  assert.match(formatToolLoopGuardMessage(blocked, 'web_search'), /wait for and use the first result/i);
});

test('explicit parallel execution allows independent fresh-news queries in one batch', () => {
  const state = createToolLoopGuardState();
  assert.equal(
    shouldShortCircuitToolCall(
      state,
      'web_search',
      { query: 'robotics news', recency: 'day' },
      { parallelBatch: true },
    ),
    null,
  );
  assert.equal(
    shouldShortCircuitToolCall(
      state,
      'web_search',
      { query: 'D-Robotics news', recency: 'week' },
      { parallelBatch: true },
    ),
    null,
  );
  assert.equal(state.webSearchQueries.size, 2);
});
