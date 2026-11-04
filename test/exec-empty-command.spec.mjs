#!/usr/bin/env node
/**
 * `exec({ command: '' })` ran an empty shell and answered "(no output)" — the
 * same string a command that ran and printed nothing produces. The model could
 * not tell that nothing happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execTool } from '../dist/tools/builtin.js';

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ctxFor = (workspaceDir) => ({
  workspaceDir,
  sessionKey: 'exec-empty-command',
  abortSignal: new AbortController().signal,
});

test('an empty command reports that nothing ran', async (t) => {
  const dir = await workspace(t);
  for (const command of ['', '   ']) {
    const out = await execTool.execute({ command }, ctxFor(dir));
    assert.match(out, /^Error: exec needs a command\. Nothing ran/);
  }
});

test('a quiet command still runs and reports an empty result', async (t) => {
  const dir = await workspace(t);
  const out = await execTool.execute({ command: 'true' }, ctxFor(dir));
  assert.doesNotMatch(out, /needs a command/);
});
