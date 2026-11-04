#!/usr/bin/env node
/**
 * read_file promises text. A PNG used to arrive as one line of "PNG" (the NUL
 * bytes were dropped by the renderer), which reads as the file's content; a
 * directory path produced a raw EISDIR from `readFile`.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-binary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a binary file is refused with a pointer to a byte-capable tool', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const out = await readFileTool.execute({ path: 'img.png' }, ctx(dir));
  assert.match(out, /^Error: img\.png is binary \(NUL byte at offset 4\)/);
  assert.match(out, /xxd|device_file_read/);
});

test('a directory is named as one instead of EISDIR', async (t) => {
  const dir = await workspace(t);
  await fs.mkdir(path.join(dir, 'sub'));
  const out = await readFileTool.execute({ path: 'sub' }, ctx(dir));
  assert.match(out, /^Error: sub is a directory, not a file/);
  assert.match(out, /list_directory/);
});
