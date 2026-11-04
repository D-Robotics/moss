#!/usr/bin/env node
/**
 * list_directory on a target that is not a directory used to throw the raw
 * `ENOTDIR`/`ENOENT` from `readdir`, which names the syscall and nothing the
 * model can act on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectoryTool } from '../dist/tools/builtin.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-target-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'file.txt'), 'hello\n');
  return dir;
}

test('a file target points at read_file instead of failing on readdir', async (t) => {
  const dir = await workspace(t);
  const out = await listDirectoryTool.execute({ path: 'file.txt' }, ctx(dir));
  assert.match(out, /^Error: file\.txt is a file, not a directory/);
  assert.match(out, /read_file/);
});

test('a missing directory points at search_files', async (t) => {
  const dir = await workspace(t);
  const out = await listDirectoryTool.execute({ path: 'nope/' }, ctx(dir));
  assert.match(out, /^Error: no such directory: nope\//);
  assert.match(out, /search_files/);
});
