import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  editFileTool,
  writeFileTool,
  stripLineNumberPrefixes,
  findTrailingWsMatches,
  findClosestLineHints,
} from '../dist/tools/file-tools.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function markRead(workspaceDir, rel) {
  const abs = path.join(workspaceDir, rel);
  await globalToolStateManager.recordFileState(abs);
}


test('stripLineNumberPrefixes removes read_file prefixes', () => {
  const raw = '    12\tconst x = 1;\n    13\tconst y = 2;';
  assert.equal(stripLineNumberPrefixes(raw), 'const x = 1;\nconst y = 2;');
});

test('edit_file succeeds when old_string includes line-number prefixes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
  await markRead(dir, 'a.ts');

  const out = await editFileTool.execute(
    {
      path: 'a.ts',
      old_string: '     1\tconst x = 1;',
      new_string: 'const x = 42;',
    },
    ctx(dir)
  );
  assert.match(out, /Edited a\.ts/);
  const body = await fs.readFile(path.join(dir, 'a.ts'), 'utf8');
  assert.equal(body, 'const x = 42;\nconst y = 2;\n');
});

test('edit_file matches ignoring trailing whitespace per line', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'b.ts'), 'function f() {  \n  return 1;  \n}\n');
  await markRead(dir, 'b.ts');

  const out = await editFileTool.execute(
    {
      path: 'b.ts',
      old_string: 'function f() {\n  return 1;\n}',
      new_string: 'function f() {\n  return 2;\n}',
    },
    ctx(dir)
  );
  assert.match(out, /trailing whitespace/);
  const body = await fs.readFile(path.join(dir, 'b.ts'), 'utf8');
  assert.match(body, /return 2/);
});

test('edit_file not-found includes closest line hints', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'c.ts'), 'export const CamelCaseToken = 1;\n');
  await markRead(dir, 'c.ts');

  const out = await editFileTool.execute(
    {
      path: 'c.ts',
      old_string: 'export const CamelCaseToken = 999;',
      new_string: 'export const CamelCaseToken = 2;',
    },
    ctx(dir)
  );
  assert.match(out, /old_string not found/);
  assert.match(out, /Closest lines/);
  assert.match(out, /CamelCaseToken/);
  assert.match(out, /read_file/i, 'miss error must force re-read before retry');
  assert.match(out, /Do not retry the same old_string/i);
});

test('findTrailingWsMatches and findClosestLineHints unit helpers', () => {
  const content = 'alpha  \nbeta\n';
  const matches = findTrailingWsMatches(content, 'alpha\nbeta', false);
  assert.equal(matches.length, 1);
  const hints = findClosestLineHints(content, 'alphazzz');
  assert.ok(hints.some((h) => h.includes('alpha')));
});

test('write_file rejects overwrite of existing unread file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-write-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'keep.txt'), 'original\n');

  const blocked = await writeFileTool.execute(
    { path: 'keep.txt', content: 'clobber\n' },
    ctx(dir),
  );
  assert.match(blocked, /must call read_file|before editing/i);
  assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'original\n');

  await markRead(dir, 'keep.txt');
  const ok = await writeFileTool.execute({ path: 'keep.txt', content: 'rewritten\n' }, ctx(dir));
  assert.match(ok, /Successfully wrote/);
  assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'rewritten\n');
});

test('write_file creates new files without prior read', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-write-new-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ok = await writeFileTool.execute({ path: 'brand-new.txt', content: 'hello\n' }, ctx(dir));
  assert.match(ok, /Successfully wrote/);
  assert.equal(await fs.readFile(path.join(dir, 'brand-new.txt'), 'utf8'), 'hello\n');
});

test('edit_file miss invalidates prior-read so next edit requires re-read', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-inv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'd.ts'), 'export const token = 1;\n');
  await markRead(dir, 'd.ts');

  const miss = await editFileTool.execute(
    {
      path: 'd.ts',
      old_string: 'export const token = 999;',
      new_string: 'export const token = 2;',
    },
    ctx(dir),
  );
  assert.match(miss, /old_string not found/);

  const blocked = await editFileTool.execute(
    {
      path: 'd.ts',
      old_string: 'export const token = 1;',
      new_string: 'export const token = 2;',
    },
    ctx(dir),
  );
  assert.match(blocked, /must call read_file|before editing/i);

  await markRead(dir, 'd.ts');
  const ok = await editFileTool.execute(
    {
      path: 'd.ts',
      old_string: 'export const token = 1;',
      new_string: 'export const token = 2;',
    },
    ctx(dir),
  );
  assert.match(ok, /Edited/);
  assert.equal(await fs.readFile(path.join(dir, 'd.ts'), 'utf8'), 'export const token = 2;\n');
});
