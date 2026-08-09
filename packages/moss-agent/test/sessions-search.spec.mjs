#!/usr/bin/env node
/**
 * `moss sessions search <text>` — locate a saved session by content.
 * Exercises searchSessions (the search core extracted from the CLI handler).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import {
  searchSessions,
  formatSessionTitle,
  renderSessionMarkdown,
} from '../dist/cli/command-dispatcher.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-sessions-search-'));
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-sessions-empty-'));
try {
  const store = new JsonlSessionStore({ dir: tmp });

  await store.replaceMessages('s-oauth', [
    { role: 'user', content: 'fix the OAuth login bug on the settings page' },
    { role: 'assistant', content: [{ type: 'text', text: 'on it — reproducing first' }] },
  ]);
  await store.replaceMessages('s-refactor', [
    { role: 'user', content: 'refactor the auth module into smaller files' },
    { role: 'assistant', content: [{ type: 'text', text: 'planning the split' }] },
  ]);
  await store.replaceMessages('s-toolresult', [
    { role: 'user', content: 'run the migration' },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'migration succeeded: migrated 42 rows from legacy_oauth_tokens',
        },
      ],
    },
  ]);

  {
    // Finds the session whose user text contains the query (case-insensitive).
    const hits = await searchSessions(store, 'OAuth login');
    assert.equal(hits.length, 1, 'one session matches "OAuth login"');
    assert.equal(hits[0].key, 's-oauth');
    assert.match(hits[0].snippet, /OAuth/i, 'snippet includes the matched term');
  }

  {
    // Case-insensitive: "AUTH module" matches the refactor session's "auth module".
    const hits = await searchSessions(store, 'AUTH module');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, 's-refactor');
  }

  {
    // Matches tool_result content, not only user text.
    const hits = await searchSessions(store, 'legacy_oauth_tokens');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, 's-toolresult');
    assert.match(hits[0].snippet, /legacy_oauth_tokens/);
  }

  {
    const hits = await searchSessions(store, 'this-string-does-not-exist-anywhere');
    assert.equal(hits.length, 0, 'no matches returns empty');
  }

  {
    const empty = new JsonlSessionStore({ dir: emptyDir });
    const hits = await searchSessions(empty, 'anything');
    assert.equal(hits.length, 0, 'empty store returns no hits');
  }

  console.log('[PASS] sessions search');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
}

// ─── formatSessionTitle — TITLE column normalization ───────────────────────

{
  assert.equal(
    formatSessionTitle('fix the login bug'),
    'fix the login bug',
    'short title unchanged'
  );
}
{
  assert.equal(
    formatSessionTitle('  fix   the   bug  '),
    'fix the bug',
    'collapses and trims whitespace'
  );
}
{
  assert.equal(formatSessionTitle(undefined), '(no title)', 'undefined → placeholder');
}
{
  assert.equal(formatSessionTitle(''), '(no title)', 'empty → placeholder');
}
{
  const long = 'x'.repeat(80);
  const out = formatSessionTitle(long);
  assert.equal(out.length, 50, 'truncated to max width');
  assert.ok(out.endsWith('…'), 'truncated title ends with ellipsis');
}
console.log('[PASS] sessions title format');

// ─── renderSessionMarkdown — `moss sessions export` ───────────────────────

{
  const md = renderSessionMarkdown('s1', [
    { role: 'user', content: 'fix the bug' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'investigating' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'edit_file',
          input: { path: 'src/a.ts', old: 'x', new: 'y' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'edited src/a.ts' }],
    },
  ]);
  assert.match(md, /# Session s1/, 'has a session heading');
  assert.match(md, /## user/, 'renders user role');
  assert.match(md, /## assistant/, 'renders assistant role');
  assert.match(md, /fix the bug/, 'preserves user text verbatim');
  assert.match(md, /\/\/ tool_use edit_file/, 'renders tool_use name');
  assert.match(md, /"path":"src\/a\.ts"/, 'includes tool_use input as JSON');
  assert.match(md, /tool_result:/, 'renders tool_result label');
  assert.match(md, /edited src\/a\.ts/, 'preserves tool_result body');
}
{
  const long = 'x'.repeat(5000);
  const md = renderSessionMarkdown('s2', [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: long }] },
  ]);
  assert.ok(!md.includes(long), 'truncates very long tool_result bodies');
}
{
  const md = renderSessionMarkdown('s3', []);
  assert.match(md, /# Session s3/, 'empty session still renders a heading');
  assert.match(md, /0 message/, 'notes the message count');
}
console.log('[PASS] sessions export markdown');
