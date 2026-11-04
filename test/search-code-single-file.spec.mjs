#!/usr/bin/env node
/**
 * Searching one file, and the per-file share of the result cap.
 *
 * `search_code({ path: 'src/hot.ts' })` returned "No matches found" for a file
 * that matched. Two independent causes: the child got a file as `cwd`
 * (spawn ENOTDIR), and ripgrep drops the path prefix when the target is one
 * file, so the `path:line:` parser discarded every line. The JS fallback had a
 * third: `readdir` on a file fails, so it walked nothing.
 *
 * The second half pins Qoder's `Grep.max_matches_per_file`: one bundled file
 * must not consume the whole result budget, and a file that stopped at the cap
 * has to say so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchCodeTool, searchFilesTool, grepWalk } from '../dist/tools/search-tools.js';

const ctxFor = (workspaceDir) => ({
  workspaceDir,
  sessionKey: 'search-single-file',
  abortSignal: new AbortController().signal,
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-single-'));
  const hot = ['// header', ...Array.from({ length: 30 }, (_, i) => `call(${i});`)].join('\n');
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'hot.js'), hot + '\n');
  await fs.writeFile(path.join(dir, 'src', 'other.js'), 'call(1);\n');
  return dir;
}

test('a search scoped to one file returns that file’s matches', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ctx = ctxFor(dir);

  for (const target of ['src/hot.js', path.join(dir, 'src', 'hot.js')]) {
    const out = await searchCodeTool.execute({ pattern: 'call\\(', path: target }, ctx);
    assert.match(out, /src\/hot\.js:2:> call\(0\);/, `target ${target} must search the file`);
    assert.doesNotMatch(out, /other\.js/, 'a single-file search must not widen to the directory');
  }

  const counted = await searchCodeTool.execute(
    { pattern: 'call\\(', path: 'src/hot.js', output_mode: 'count' },
    ctx
  );
  assert.match(counted, /src\/hot\.js: 30/);
});

test('the JS fallback also searches a single file', async () => {
  const dir = await fixture();
  try {
    const results = await grepWalk(
      path.join(dir, 'src', 'hot.js'),
      /call\(/g,
      null,
      50,
      100_000,
      5_000,
      dir
    );
    assert.ok(results.length > 0, 'grepWalk must scan the named file, not readdir it');
    assert.ok(
      results.some((line) => /^src\/hot\.js:\d+:> call\(/.test(line)),
      'grepWalk must report the file’s matching lines'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('search_files accepts a file path', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = await searchFilesTool.execute({ pattern: 'hot.js', path: 'src/hot.js' }, ctxFor(dir));
  assert.match(out, /src\/hot\.js/);
});

test('one hot file cannot take the whole result cap, and says it was capped', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ctx = ctxFor(dir);

  const out = await searchCodeTool.execute(
    { pattern: 'call\\(', head_limit: 20, context_lines: 0 },
    ctx
  );
  const hotMatches = (out.match(/src\/hot\.js:\d+:> /g) ?? []).length;
  assert.equal(hotMatches, 5, 'default share is a quarter of head_limit (20 → 5)');
  assert.match(out, /src\/other\.js:1:> /, 'other files keep their place in the result');
  assert.match(out, /per-file cap of 5 matches hit in src\/hot\.js/);

  const widened = await searchCodeTool.execute(
    { pattern: 'call\\(', head_limit: 40, context_lines: 0, max_matches_per_file: 40 },
    ctx
  );
  assert.match(widened, /src\/hot\.js:31:> call\(29\);/, 'the override reaches every match');
  assert.doesNotMatch(widened, /per-file cap/);
});
