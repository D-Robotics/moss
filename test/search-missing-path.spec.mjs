#!/usr/bin/env node
/**
 * A search under a path that does not exist must say so.
 *
 * `search_code {path: "nope/"}` answered "No matches found" and `search_files`
 * answered "No files found" — indistinguishable from a real directory with no
 * hits, so a typo read as "the code is not there".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchCodeTool, searchFilesTool } from '../dist/tools/search-tools.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.ts'), 'const alpha = 1;\n');
  return dir;
}

test('search_code refuses a missing path instead of reporting no matches', async (t) => {
  const dir = await workspace(t);
  const out = await searchCodeTool.execute({ pattern: 'alpha', path: 'nope/' }, ctx(dir));
  assert.match(out, /^Error: no such path: nope\//);
  assert.doesNotMatch(out, /No matches found/);
});

test('search_files refuses a missing path instead of reporting no files', async (t) => {
  const dir = await workspace(t);
  const out = await searchFilesTool.execute({ pattern: '*.ts', path: 'nope/' }, ctx(dir));
  assert.match(out, /^Error: no such path: nope\//);
  assert.doesNotMatch(out, /No files found/);
});

test('an existing path with no hits still reports no matches', async (t) => {
  const dir = await workspace(t);
  const out = await searchCodeTool.execute({ pattern: 'zzz-not-there', path: '.' }, ctx(dir));
  assert.match(out, /No matches found/);
});

test('an existing file path still searches it', async (t) => {
  const dir = await workspace(t);
  const out = await searchCodeTool.execute({ pattern: 'alpha', path: 'a.ts' }, ctx(dir));
  assert.match(out, /a\.ts:1/);
});
