#!/usr/bin/env node
/**
 * A single-file `edits[]` batch may name the file once.
 *
 * `{path: "x.ts", edits: [{old_string, new_string}]}` is how Claude Code's Edit
 * and Cursor's multi-edit carry a batch inside one file. multi_edit rejected it
 * with `edits[0].path is required` — true to the schema, one wasted turn per
 * occurrence. Entries inherit the top-level path when they omit one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { multiEditTool, editFileTool } from '../dist/tools/file-tools.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-batch-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'p.txt'), 'alpha\nbeta\ngamma\n');
  await globalToolStateManager.recordFileState(path.join(dir, 'p.txt'));
  return dir;
}

test('multi_edit inherits the top-level path for entries without one', async (t) => {
  const dir = await workspace(t);
  const out = await multiEditTool.execute(
    {
      path: 'p.txt',
      edits: [
        { old_string: 'alpha', new_string: 'A' },
        { old_string: 'gamma', new_string: 'G' },
      ],
    },
    ctx(dir)
  );
  assert.match(out, /Applied 2 edit\(s\)/);
  assert.equal(await fs.readFile(path.join(dir, 'p.txt'), 'utf8'), 'A\nbeta\nG\n');
});

test('edit_file edits[] inherits the top-level path too', async (t) => {
  const dir = await workspace(t);
  const out = await editFileTool.execute(
    { path: 'p.txt', edits: [{ old_string: 'beta', new_string: 'B' }] },
    ctx(dir)
  );
  assert.match(out, /Applied 1 edit\(s\)/);
  assert.equal(await fs.readFile(path.join(dir, 'p.txt'), 'utf8'), 'alpha\nB\ngamma\n');
});

test('an explicit entry path still wins over the top-level one', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'q.txt'), 'alpha\n');
  await globalToolStateManager.recordFileState(path.join(dir, 'q.txt'));
  const out = await multiEditTool.execute(
    {
      path: 'p.txt',
      edits: [{ path: 'q.txt', old_string: 'alpha', new_string: 'Q' }],
    },
    ctx(dir)
  );
  assert.match(out, /q\.txt/);
  assert.equal(await fs.readFile(path.join(dir, 'q.txt'), 'utf8'), 'Q\n');
  assert.equal(await fs.readFile(path.join(dir, 'p.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
});

test('a batch with no path anywhere still asks for one', async (t) => {
  const dir = await workspace(t);
  const out = await multiEditTool.execute(
    { edits: [{ old_string: 'alpha', new_string: 'A' }] },
    ctx(dir)
  );
  assert.match(out, /^Error: edits\[0\]\.path is required/);
});

test('edits[] entries accept file_path / old_str / new_str spellings', async (t) => {
  const dir = await workspace(t);
  const out = await multiEditTool.execute(
    { edits: [{ file_path: 'p.txt', old_str: 'beta', new_str: 'B' }] },
    ctx(dir)
  );
  assert.match(out, /Applied 1 edit\(s\)/);
  assert.equal(await fs.readFile(path.join(dir, 'p.txt'), 'utf8'), 'alpha\nB\ngamma\n');
});
