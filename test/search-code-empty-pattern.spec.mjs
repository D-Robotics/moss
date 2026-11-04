#!/usr/bin/env node
/**
 * A blank search pattern is a zero-length regex.
 *
 * `search_code({ pattern: '' })` matched every line of every file and returned
 * the dump as if it were an answer — on a real repository that is the whole
 * workspace in the context window. Nothing was asked for, so nothing should be
 * searched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchCodeTool } from '../dist/tools/search-tools.js';

const ctxFor = (workspaceDir) => ({
  workspaceDir,
  sessionKey: 'search-code-empty-pattern',
  abortSignal: new AbortController().signal,
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.js'), 'alpha\nbeta\ngamma\n');
  return dir;
}

test('an empty pattern is refused instead of matching every line', async (t) => {
  const dir = await fixture(t);
  const out = await searchCodeTool.execute({ pattern: '' }, ctxFor(dir));
  assert.match(out, /^Error: search_code needs a pattern\./);
  assert.doesNotMatch(out, /alpha|beta|gamma/);
});

test('a whitespace-only pattern is refused and names the regex form', async (t) => {
  const dir = await fixture(t);
  const out = await searchCodeTool.execute({ pattern: '   ' }, ctxFor(dir));
  assert.match(out, /^Error: search_code needs a pattern\./);
  assert.match(out, /\\s/);
});

test('a real pattern still searches', async (t) => {
  const dir = await fixture(t);
  const out = await searchCodeTool.execute({ pattern: 'beta' }, ctxFor(dir));
  assert.match(out, /a\.js:2:.*beta/);
});
