#!/usr/bin/env node
/**
 * A file tool asked to write where a directory (or a file) already is.
 *
 * `write_file({path: 'adir/'})` hit the prior-read gate, whose advice (read it,
 * then retry) can never work: read_file refuses a directory. `f.txt/sub/x` and
 * `edit_file({path: 'adir'})` surfaced raw Node errnos — `ENOTDIR: not a
 * directory, lstat '/abs/path'` — which named neither the caller's path nor
 * what to do next.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { editFileTool, writeFileTool } from '../dist/tools/file-tools.js';

function ctx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'file-tool-path-kind',
    abortSignal: new AbortController().signal,
  };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-path-kind-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'adir'));
  await fs.writeFile(path.join(dir, 'f.txt'), 'alpha\n');
  return dir;
}

test('writing to a directory says it is a directory and writes nothing', async (t) => {
  const dir = await workspace(t);
  for (const target of ['adir', 'adir/']) {
    const out = await writeFileTool.execute({ path: target, content: 'x' }, ctx(dir));
    assert.match(out, /^Error: adir\/? is a directory, not a file\. Nothing was written\./);
    assert.doesNotMatch(out, /must call read_file/);
  }
  assert.deepEqual(await fs.readdir(path.join(dir, 'adir')), []);
});

test('a file that cannot be a parent is named, not reported as a raw errno', async (t) => {
  const dir = await workspace(t);
  const out = await writeFileTool.execute({ path: 'f.txt/sub/x.txt', content: 'x' }, ctx(dir));
  assert.match(out, /^Error: cannot create f\.txt\/sub\/x\.txt — a parent path is a file/);
  assert.doesNotMatch(out, /ENOTDIR|lstat|\/tmp/);
});

test('editing a directory says it is a directory and changes nothing', async (t) => {
  const dir = await workspace(t);
  const out = await editFileTool.execute(
    { path: 'adir', old_string: 'a', new_string: 'b' },
    ctx(dir)
  );
  assert.match(out, /^Error: adir is a directory, not a file\. Nothing was changed\./);
  assert.doesNotMatch(out, /EISDIR/);
});

test('a regular file still goes through the prior-read gate', async (t) => {
  const dir = await workspace(t);
  const out = await writeFileTool.execute({ path: 'f.txt', content: 'x' }, ctx(dir));
  assert.match(out, /^Error: You must call read_file on f\.txt/);
});
