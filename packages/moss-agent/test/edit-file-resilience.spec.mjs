import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  editFileTool,
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
