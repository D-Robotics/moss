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
