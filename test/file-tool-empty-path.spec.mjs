#!/usr/bin/env node
/**
 * An empty path must never resolve to the workspace root.
 *
 * `move_file {source: "", destination: "out"}` reached `rename(workspace,
 * workspace/out)` — the whole workspace was the source of the move. The call
 * failed only because the target sat inside the source (EINVAL). Both path
 * arguments are now required, and the other file tools say the same.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { builtinTools } from '../dist/tools/builtin.js';

const tools = Object.fromEntries(builtinTools.map((tool) => [tool.name, tool]));

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-empty-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
  return dir;
}

test('move_file refuses an empty source and leaves the workspace in place', async (t) => {
  const dir = await workspace(t);
  const out = await tools.move_file.execute({ source: '', destination: 'out' }, ctx(dir));
  assert.match(out, /^Error: move_file needs both source and destination paths/);
  // The workspace directory (and its file) must still be where it was.
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'alpha\n');
});

test('move_file refuses an empty destination', async (t) => {
  const dir = await workspace(t);
  const out = await tools.move_file.execute({ source: 'a.txt', destination: '' }, ctx(dir));
  assert.match(out, /^Error: move_file needs both source and destination paths/);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'alpha\n');
});

test('move_file still moves a real file', async (t) => {
  const dir = await workspace(t);
  const out = await tools.move_file.execute({ source: 'a.txt', destination: 'b.txt' }, ctx(dir));
  assert.doesNotMatch(out, /^Error/);
  assert.equal(await fs.readFile(path.join(dir, 'b.txt'), 'utf8'), 'alpha\n');
});

test('write_file refuses an empty path', async (t) => {
  const dir = await workspace(t);
  const out = await tools.write_file.execute({ path: '', content: 'x' }, ctx(dir));
  assert.match(out, /^Error: write_file needs a path/);
});

test('read_file names the workspace root instead of showing a blank path', async (t) => {
  const dir = await workspace(t);
  const out = await tools.read_file.execute({ path: '' }, ctx(dir));
  assert.match(out, /^Error: the workspace root is a directory, not a file/);
});
