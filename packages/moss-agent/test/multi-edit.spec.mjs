import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  multiEditTool,
  applyPreciseEditToContent,
  editFileTool,
} from '../dist/tools/file-tools.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function markRead(workspaceDir, rel) {
  const abs = path.join(workspaceDir, rel);
  await globalToolStateManager.recordFileState(abs);
}


test('applyPreciseEditToContent exact replace', () => {
  const r = applyPreciseEditToContent('const a = 1;\nconst b = 2;\n', {
    oldString: 'const a = 1;',
    newString: 'const a = 9;',
  });
  assert.equal(r.ok, true);
  assert.equal(r.content, 'const a = 9;\nconst b = 2;\n');
  assert.equal(r.matchMode, 'exact');
});

test('multi_edit applies two files all-or-nothing', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-multi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const A = 1;\n');
  await markRead(dir, 'a.ts');
  await fs.writeFile(path.join(dir, 'b.ts'), 'export const B = 1;\n');
  await markRead(dir, 'b.ts');

  const out = await multiEditTool.execute(
    {
      edits: [
        { path: 'a.ts', old_string: 'export const A = 1;', new_string: 'export const A = 2;' },
        { path: 'b.ts', old_string: 'export const B = 1;', new_string: 'export const B = 2;' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /Applied 2 edit/);
  assert.equal(await fs.readFile(path.join(dir, 'a.ts'), 'utf8'), 'export const A = 2;\n');
  assert.equal(await fs.readFile(path.join(dir, 'b.ts'), 'utf8'), 'export const B = 2;\n');
});

test('multi_edit rolls back all files when a later edit fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-multi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const A = 1;\n');
  await markRead(dir, 'a.ts');
  await fs.writeFile(path.join(dir, 'b.ts'), 'export const B = 1;\n');
  await markRead(dir, 'b.ts');

  const out = await multiEditTool.execute(
    {
      edits: [
        { path: 'a.ts', old_string: 'export const A = 1;', new_string: 'export const A = 2;' },
        { path: 'b.ts', old_string: 'export const MISSING = 1;', new_string: 'export const B = 2;' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /No files were written/);
  // a.ts must remain original because commit is all-or-nothing
  assert.equal(await fs.readFile(path.join(dir, 'a.ts'), 'utf8'), 'export const A = 1;\n');
  assert.equal(await fs.readFile(path.join(dir, 'b.ts'), 'utf8'), 'export const B = 1;\n');
});

test('multi_edit chains ordered edits on the same file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-multi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'c.ts'), 'const x = 1;\nconst y = 2;\n');
  await markRead(dir, 'c.ts');

  const out = await multiEditTool.execute(
    {
      edits: [
        { path: 'c.ts', old_string: 'const x = 1;', new_string: 'const x = 10;' },
        { path: 'c.ts', old_string: 'const y = 2;', new_string: 'const y = 20;' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /Applied 2 edit/);
  assert.equal(await fs.readFile(path.join(dir, 'c.ts'), 'utf8'), 'const x = 10;\nconst y = 20;\n');
});

test('edit_file still works via shared applyPreciseEditToContent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'd.ts'), 'hello world\n');
  await markRead(dir, 'd.ts');
  const out = await editFileTool.execute(
    { path: 'd.ts', old_string: 'hello world', new_string: 'hello moss' },
    ctx(dir)
  );
  assert.match(out, /Edited d\.ts/);
  assert.equal(await fs.readFile(path.join(dir, 'd.ts'), 'utf8'), 'hello moss\n');
});
