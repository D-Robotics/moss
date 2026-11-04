#!/usr/bin/env node
/**
 * ripgrep skips binary files. A search scoped to one therefore answered "No
 * matches found" for a file whose bytes do contain the text — a false negative
 * that reads as "this string is unused". Name the binary and how to search it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchCodeTool } from '../dist/tools/search-tools.js';

const ctxFor = (workspaceDir) => ({
  workspaceDir,
  sessionKey: 'search-code-binary-target',
  abortSignal: new AbortController().signal,
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-binary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from('xx\x00needle\x00yy', 'binary'));
  await fs.writeFile(path.join(dir, 'text.txt'), 'only words here\n');
  return dir;
}

test('a search inside a binary file says so instead of "No matches found"', async (t) => {
  const dir = await fixture(t);
  const out = await searchCodeTool.execute({ pattern: 'needle', path: 'blob.bin' }, ctxFor(dir));
  assert.match(out, /^No text matches in blob\.bin — the file is binary \(NUL byte at offset 2\)/);
  assert.match(out, /rg -a "needle" "blob\.bin"/);
  assert.doesNotMatch(out, /^No matches found/);
});

test('a genuine miss in a text file still reads as no matches', async (t) => {
  const dir = await fixture(t);
  const out = await searchCodeTool.execute({ pattern: 'needle', path: 'text.txt' }, ctxFor(dir));
  assert.equal(out, 'No matches found');
});

test('a missing pattern in a directory search is not called binary', async (t) => {
  const dir = await fixture(t);
  const out = await searchCodeTool.execute({ pattern: 'needle' }, ctxFor(dir));
  assert.equal(out, 'No matches found');
});
