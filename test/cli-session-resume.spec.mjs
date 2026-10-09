#!/usr/bin/env node
/**
 * Non-TTY /resume: a query that matches several sessions must not silently
 * pick the latest. No query still resumes the latest.
 */
import assert from 'node:assert/strict';

import {
  createCliSessionKey,
  formatCliSessionTimestamp,
  selectSessionForResume,
} from '../dist/cli/session.js';

assert.equal(
  formatCliSessionTimestamp(new Date(2026, 9, 9, 22, 55, 43)),
  '20261009225543',
  'session stamps use local time'
);
assert.match(createCliSessionKey(new Date(2026, 9, 9, 22, 55, 43)), /^cli-20261009225543-/);

function store(sessions) {
  return {
    async listSessions() {
      return sessions;
    },
  };
}

const sessions = [
  {
    sessionKey: 'alpha-one',
    title: 'Alpha notes',
    updatedAt: Date.parse('2026-10-09T03:00:00.000Z'),
    createdAt: 1,
    messageCount: 4,
  },
  {
    sessionKey: 'alpha-two',
    title: 'Alpha other',
    updatedAt: Date.parse('2026-10-09T02:00:00.000Z'),
    createdAt: 1,
    messageCount: 2,
  },
  {
    sessionKey: 'beta',
    title: 'Beta',
    updatedAt: Date.parse('2026-10-09T01:00:00.000Z'),
    createdAt: 1,
    messageCount: 1,
  },
];

const wasTTY = process.stdin.isTTY;
Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
try {
  const ambiguous = await selectSessionForResume(store(sessions), 'alpha');
  assert.equal(ambiguous.sessionKey, null, 'an ambiguous non-TTY query resumes nothing');
  assert.match(ambiguous.notice, /No session was resumed/);
  assert.match(ambiguous.notice, /alpha-one/);
  assert.match(ambiguous.notice, /Alpha notes/);
  assert.match(ambiguous.notice, /2026-10-09T03:00:00.000Z/);
  assert.match(ambiguous.notice, /alpha-two/);
  assert.match(ambiguous.notice, /Alpha other/);
  assert.doesNotMatch(ambiguous.notice, /beta/);

  const many = Array.from({ length: 12 }, (_, index) => ({
    sessionKey: `hit-${String(index).padStart(2, '0')}`,
    title: `Match ${index}`,
    updatedAt: 1_000 + index,
    createdAt: 1,
    messageCount: 1,
  }));
  const truncated = await selectSessionForResume(store(many), 'hit');
  assert.equal(truncated.sessionKey, null);
  const listed = truncated.notice.split('\n').filter((line) => line.startsWith('hit-'));
  assert.equal(listed.length, 10, 'at most 10 matches are listed');
  assert.match(truncated.notice, /hit-11/, 'the most recently updated match is listed');
  assert.doesNotMatch(truncated.notice, /hit-00/);
  assert.match(truncated.notice, /2 more not shown/);

  const latest = await selectSessionForResume(store(sessions));
  assert.equal(latest.sessionKey, 'alpha-one', 'no query still resumes the latest session');
  assert.match(latest.notice, /latest session/);

  const only = await selectSessionForResume(store(sessions), 'beta');
  assert.equal(only.sessionKey, 'beta', 'a single match still resumes');
} finally {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: wasTTY,
    configurable: true,
  });
}

console.log('[PASS] cli session resume');
