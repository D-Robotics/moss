#!/usr/bin/env node
/**
 * read_file line windows that do not exist.
 *
 * Before the guard, `{ offset: 99 }` on a 4-line file printed
 * `[lines 99-3 of 3]` with an empty body, which reads as "line 99 exists and is
 * empty"; `{ offset: 2, limit: 0 }` printed `[lines 2-1 of 3]`. Both tell the
 * model something false about the file. A window that starts past EOF is now an
 * error, and a non-positive `limit` reads at least one line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileTool } from '../dist/tools/builtin.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-window-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'small.txt'), 'alpha\nbeta\ngamma\n');
  return dir;
}

test('an offset past the last line is an error, not an empty window', async (t) => {
  const dir = await workspace(t);
  const out = await readFileTool.execute({ path: 'small.txt', offset: 99 }, ctx(dir));
  assert.match(out, /^Error: offset 99 is past the end of small\.txt/);
  assert.match(out, /Use offset 1–3/);
  assert.doesNotMatch(out, /\[lines 99-/, 'must not emit an inverted window header');
});

test('a zero or negative limit still returns one line', async (t) => {
  const dir = await workspace(t);
  // One file per case: a repeat read of an unchanged file gets the reuse stub.
  await fs.writeFile(path.join(dir, 'zero.txt'), 'alpha\nbeta\ngamma\n');
  await fs.writeFile(path.join(dir, 'negative.txt'), 'alpha\nbeta\ngamma\n');
  const cases = [
    ['zero.txt', 0],
    ['negative.txt', -5],
  ];
  for (const [file, limit] of cases) {
    const out = await readFileTool.execute({ path: file, offset: 2, limit }, ctx(dir));
    assert.match(out, /^\[lines 2-2 of 3\]/, `limit ${String(limit)} must floor at one line`);
    assert.match(out, /\n\s+2\tbeta/);
  }
});

test('a trailing newline ends the last line instead of adding an empty one', async (t) => {
  const dir = await workspace(t);
  const out = await readFileTool.execute({ path: 'small.txt' }, ctx(dir));
  assert.match(out, /\n\s+3\tgamma$/);
  assert.doesNotMatch(out, /\n\s+4\t/, 'a three-line file has no line 4');
  // The window path agrees with the full read.
  const window = await readFileTool.execute({ path: 'small.txt', offset: 3 }, ctx(dir));
  assert.match(window, /^\[lines 3-3 of 3\]/);
});
