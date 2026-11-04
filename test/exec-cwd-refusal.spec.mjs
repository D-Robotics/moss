#!/usr/bin/env node
/**
 * exec always starts at the workspace root. A model that passes the `cwd`
 * parameter its other harness's shell tool has saw the command run in the
 * wrong directory and report success — the wrong place to run `rm -rf`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execTool } from '../dist/tools/builtin.js';
import { execBackgroundTool } from '../dist/tools/background-exec.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-cwd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'sub'));
  return dir;
}

test('exec refuses an undeclared cwd instead of running at the workspace root', async (t) => {
  const dir = await workspace(t);
  const out = await execTool.execute({ command: 'touch marker.txt', cwd: 'sub' }, ctx(dir));
  assert.match(out, /exec has no cwd parameter/);
  assert.match(out, /cd "sub" &&/);
  await assert.rejects(() => fs.access(path.join(dir, 'marker.txt')), 'nothing ran');
});

test('the common working_directory and workdir spellings are refused too', async (t) => {
  const dir = await workspace(t);
  for (const key of ['working_directory', 'workdir']) {
    const out = await execTool.execute({ command: 'touch marker.txt', [key]: 'sub' }, ctx(dir));
    assert.match(out, /exec has no (working_directory|workdir) parameter/);
  }
  await assert.rejects(() => fs.access(path.join(dir, 'marker.txt')), 'nothing ran');
});

test('exec_background refuses cwd before spawning', async (t) => {
  const dir = await workspace(t);
  const out = await execBackgroundTool.execute(
    { command: 'touch marker.txt', cwd: 'sub' },
    ctx(dir)
  );
  assert.match(out, /exec has no cwd parameter/);
  await assert.rejects(() => fs.access(path.join(dir, 'marker.txt')), 'nothing ran');
});
