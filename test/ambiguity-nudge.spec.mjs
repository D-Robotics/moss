#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateAmbiguityNudge,
  looksAmbiguousCodingRequest,
} from '../dist/core/loop/ambiguity-nudge.js';

assert.equal(
  looksAmbiguousCodingRequest(
    'fix the cache bug either by rewriting the map or by adding a TTL layer — not sure which'
  ),
  true
);
assert.equal(looksAmbiguousCodingRequest('fix the cache bug'), false);
assert.equal(looksAmbiguousCodingRequest('hi'), false);

// No edits → no fire
{
  const r = evaluateAmbiguityNudge({
    toolCallsByName: { read_file: 2 },
    userText: 'implement feature A or feature B, which is better?',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Already asked → no fire
{
  const r = evaluateAmbiguityNudge({
    toolCallsByName: { edit_file: 1, ask_user_question: 1 },
    userText: 'refactor either the auth module or the session store, or both?',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Ambiguous + edit → fire
{
  const r = evaluateAmbiguityNudge({
    toolCallsByName: { edit_file: 1, read_file: 1 },
    userText:
      'Please implement rate limiting either with Redis or with an in-memory map — pick one or ask me',
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /ask_user_question|assumption|multi-interpretation/i);
}

// Once only
{
  const r = evaluateAmbiguityNudge({
    toolCallsByName: { edit_file: 2 },
    userText: 'fix A or fix B, 要么改缓存要么改队列',
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] ambiguity-nudge');
