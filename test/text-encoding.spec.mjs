#!/usr/bin/env node
/**
 * UTF-16 files are text, but half their bytes are NUL: read_file called them
 * binary, and once read worked, edit_file still matched against a UTF-8 decode
 * of the same bytes. Windows scripts and logs are the common case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { editFileTool, readFileTool, writeFileTool } from '../dist/tools/builtin.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-text-encoding-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function utf16le(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function utf16be(text) {
  const body = Buffer.from(text, 'utf16le');
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

function decodeUtf16be(bytes) {
  const body = Buffer.from(bytes.subarray(2));
  body.swap16();
  return body.toString('utf16le');
}

async function markRead(dir, rel) {
  await globalToolStateManager.recordFileState(path.join(dir, rel));
}

test('read_file returns UTF-16LE text instead of calling it binary', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'win.ps1'), utf16le('Write-Host "hi"\nExit 0\n'));
  const out = await readFileTool.execute({ path: 'win.ps1' }, ctx(dir));
  assert.doesNotMatch(out, /binary/);
  assert.match(out, /Write-Host "hi"/);
  assert.match(out, /Exit 0/);
});

test('read_file returns UTF-16BE text and drops the BOM', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'be.txt'), utf16be('alpha\nbeta\n'));
  const out = await readFileTool.execute({ path: 'be.txt' }, ctx(dir));
  assert.match(out, /^ {3,}1\talpha$/m);
  assert.doesNotMatch(out, /\uFEFF/);
});

test('read_file does not show a UTF-8 BOM as text', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(
    path.join(dir, 'bom.txt'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first line\n')])
  );
  const out = await readFileTool.execute({ path: 'bom.txt' }, ctx(dir));
  assert.match(out, /1\tfirst line/);
  assert.doesNotMatch(out, /\uFEFF/);
});

test('a NUL-bearing file without a UTF-16 BOM is still binary', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'blob.dat'), Buffer.from([0x01, 0x00, 0x02, 0x00]));
  const out = await readFileTool.execute({ path: 'blob.dat' }, ctx(dir));
  assert.match(out, /^Error: blob\.dat is binary/);
});

test('edit_file keeps UTF-16LE and its BOM', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'config.ps1');
  await fs.writeFile(file, utf16le('alpha\nbeta\n'));
  await markRead(dir, 'config.ps1');

  const out = await editFileTool.execute(
    { path: 'config.ps1', old_string: 'beta', new_string: 'BETA' },
    ctx(dir)
  );
  assert.match(out, /Edited config\.ps1/);

  const bytes = await fs.readFile(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString('utf16le'), 'alpha\nBETA\n');
});

test('edit_file keeps UTF-16BE and its BOM', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'be.txt');
  await fs.writeFile(file, utf16be('one\ntwo\n'));
  await markRead(dir, 'be.txt');

  const out = await editFileTool.execute(
    { path: 'be.txt', old_string: 'two', new_string: 'TWO' },
    ctx(dir)
  );
  assert.match(out, /Edited be\.txt/);

  const bytes = await fs.readFile(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xfe, 0xff]);
  assert.equal(decodeUtf16be(bytes), 'one\nTWO\n');
});

test('write_file over a UTF-16 file keeps the encoding', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'notes.txt');
  await fs.writeFile(file, utf16le('old\n'));
  await markRead(dir, 'notes.txt');

  const out = await writeFileTool.execute({ path: 'notes.txt', content: 'new\n' }, ctx(dir));
  assert.match(out, /Successfully wrote/);

  const bytes = await fs.readFile(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString('utf16le'), 'new\n');
});
