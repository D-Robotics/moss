#!/usr/bin/env node
/**
 * apply_patch failures must be readable and actionable.
 *
 * A hunk with no context lines was rejected with a Chinese-only message that
 * printed `[]`; the model got neither the reason nor a next step. Hunk overlap
 * and a mismatched deletion line had the same shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatchTool } from '../dist/tools/patch-tool.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-patch-errors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'p.txt'), 'alpha\nbeta\ngamma\n');
  await globalToolStateManager.recordFileState(path.join(dir, 'p.txt'));
  return dir;
}

test('a hunk without context lines says how to anchor it', async (t) => {
  const dir = await workspace(t);
  const out = await applyPatchTool.execute(
    {
      patch: '*** Begin Patch\n*** Update File: p.txt\n@@\n-nope\n+yes\n*** End Patch',
    },
    ctx(dir)
  );
  assert.match(out, /Patch rejected for p\.txt: hunk could not be placed/);
  assert.match(out, /no context lines to anchor it/);
  assert.match(out, /Add 2-3 unchanged lines/);
  assert.doesNotMatch(out, /[\u4e00-\u9fff]/);
  assert.equal(await fs.readFile(path.join(dir, 'p.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
});

test('a context mismatch names the context it looked for', async (t) => {
  const dir = await workspace(t);
  const out = await applyPatchTool.execute(
    {
      patch: '*** Begin Patch\n*** Update File: p.txt\n@@\n absent\n-alpha\n+A\n*** End Patch',
    },
    ctx(dir)
  );
  assert.match(out, /context "absent" does not match the file/);
  assert.match(out, /Re-read the file/);
});

test('an unrecognized patch body names the expected format', async (t) => {
  const dir = await workspace(t);
  const out = await applyPatchTool.execute({ patch: 'hello' }, ctx(dir));
  assert.match(out, /no patch block recognized/);
  assert.match(out, /\*\*\* Update File: <path>/);
  assert.doesNotMatch(out, /[\u4e00-\u9fff]/);
});
