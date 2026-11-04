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
        {
          path: 'b.ts',
          old_string: 'export const MISSING = 1;',
          new_string: 'export const B = 2;',
        },
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

test('edit_file is the canonical batch surface (edits[] merges the old multi_edit)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'e.ts'), 'const a = 1;\nconst b = 2;\n');
  await markRead(dir, 'e.ts');

  const out = await editFileTool.execute(
    {
      edits: [
        { path: 'e.ts', old_string: 'const a = 1;', new_string: 'const a = 11;' },
        { path: 'e.ts', old_string: 'const b = 2;', new_string: 'const b = 22;' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /Applied 2 edit/);
  assert.equal(await fs.readFile(path.join(dir, 'e.ts'), 'utf8'), 'const a = 11;\nconst b = 22;\n');
});

test('edit_file rejects a call that fits neither the single nor the batch shape', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-bad-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'f.ts'), 'x\n');
  await markRead(dir, 'f.ts');

  const noPath = await editFileTool.execute({ old_string: 'x', new_string: 'y' }, ctx(dir));
  assert.match(noPath, /path is required/);
  const noStrings = await editFileTool.execute({ path: 'f.ts' }, ctx(dir));
  assert.match(noStrings, /old_string and new_string are required/);
  assert.equal(await fs.readFile(path.join(dir, 'f.ts'), 'utf8'), 'x\n');
});

test('multi_edit stays a working alias of the merged edit surface', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-alias-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'g.ts'), 'alpha\n');
  await markRead(dir, 'g.ts');

  const out = await multiEditTool.execute(
    { edits: [{ path: 'g.ts', old_string: 'alpha', new_string: 'beta' }] },
    ctx(dir)
  );
  assert.match(out, /Applied 1 edit/);
  assert.equal(await fs.readFile(path.join(dir, 'g.ts'), 'utf8'), 'beta\n');
});

test('ambiguous single edit names the sites and options, writes nothing, keeps read credit', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-ambig-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = 'header\nconst dup = 0;\nmid\nconst dup = 0;\ntail\n';
  const file = path.join(dir, 'h.ts');
  await fs.writeFile(file, original);
  await markRead(dir, 'h.ts');

  const out = await editFileTool.execute(
    { path: 'h.ts', old_string: 'const dup = 0;', new_string: 'const dup = 1;' },
    ctx(dir)
  );
  assert.match(out, /old_string is not unique \(2 matches, lines 2, 4\)/);
  assert.match(out, /replace_all: true/);
  assert.match(out, /edits\[\]/);
  assert.equal(await fs.readFile(file, 'utf8'), original, 'no bytes changed on disk');

  // Read credit survives the ambiguity: replace_all applies without a re-read.
  const retry = await editFileTool.execute(
    { path: 'h.ts', old_string: 'const dup = 0;', new_string: 'const dup = 1;', replace_all: true },
    ctx(dir)
  );
  assert.match(retry, /Edited h\.ts \(replaced 2 occurrences/);
  assert.equal(
    await fs.readFile(file, 'utf8'),
    'header\nconst dup = 1;\nmid\nconst dup = 1;\ntail\n'
  );
});

test('ambiguous batch entry fails all-or-nothing and names the entry and sites', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-batch-ambig-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ambiguous = 'a\nDUP\nb\nDUP\nc\n';
  await fs.writeFile(path.join(dir, 'i.ts'), ambiguous);
  await markRead(dir, 'i.ts');
  await fs.writeFile(path.join(dir, 'j.ts'), 'keep\n');
  await markRead(dir, 'j.ts');

  const out = await editFileTool.execute(
    {
      edits: [
        { path: 'i.ts', old_string: 'DUP', new_string: 'ONE' },
        { path: 'j.ts', old_string: 'keep', new_string: 'changed' },
      ],
    },
    ctx(dir)
  );
  assert.match(
    out,
    /Error: edits\[0\] on i\.ts: old_string is not unique \(2 matches, lines 2, 4\)/
  );
  assert.match(out, /replace_all: true/);
  assert.match(out, /No files were written/);
  assert.equal(await fs.readFile(path.join(dir, 'i.ts'), 'utf8'), ambiguous);
  assert.equal(await fs.readFile(path.join(dir, 'j.ts'), 'utf8'), 'keep\n');
});

test('not-found edits still report the exact-match next step', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-miss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'k.ts'), 'present\n');
  await markRead(dir, 'k.ts');

  const out = await editFileTool.execute(
    { path: 'k.ts', old_string: 'absent', new_string: 'x' },
    ctx(dir)
  );
  assert.match(out, /old_string not found in k\.ts/);
  assert.doesNotMatch(out, /replace_all: true/);
});
