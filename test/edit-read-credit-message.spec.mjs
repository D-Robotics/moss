#!/usr/bin/env node
/**
 * A withdrawn read credit must not be reported as "never read".
 *
 * A failed edit drops the read credit on purpose, so the next edit is refused.
 * The refusal said "You must call read_file ... at least once before editing
 * it" — false to a model that read the file two calls ago, and enough to make
 * it distrust the whole guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { builtinTools } from '../dist/tools/builtin.js';

const tools = Object.fromEntries(builtinTools.map((tool) => [tool.name, tool]));

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-credit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'f.txt'), 'alpha\nbeta\ngamma\n');
  return dir;
}

test('after a missed edit the next refusal names the withdrawn credit', async (t) => {
  const dir = await workspace(t);
  const first = await tools.read_file.execute({ path: 'f.txt' }, ctx(dir));
  assert.match(first, /alpha/);

  const missed = await tools.edit_file.execute(
    { path: 'f.txt', old_string: '  beta', new_string: 'B' },
    ctx(dir)
  );
  assert.match(missed, /old_string not found/);

  const again = await tools.edit_file.execute(
    { path: 'f.txt', old_string: 'gamma', new_string: 'G' },
    ctx(dir)
  );
  assert.match(again, /^Error: The last edit attempt on f\.txt did not apply/);
  assert.doesNotMatch(again, /at least once before editing/);
});

test('a file that was never read still gets the plain read-first refusal', async (t) => {
  const dir = await workspace(t);
  const out = await tools.edit_file.execute(
    { path: 'f.txt', old_string: 'gamma', new_string: 'G' },
    ctx(dir)
  );
  assert.match(out, /^Error: You must call read_file on f\.txt at least once before editing it/);
});

test('a successful re-read restores clean credit text', async (t) => {
  const dir = await workspace(t);
  await tools.read_file.execute({ path: 'f.txt' }, ctx(dir));
  await tools.edit_file.execute({ path: 'f.txt', old_string: '  beta', new_string: 'B' }, ctx(dir));
  await tools.read_file.execute({ path: 'f.txt' }, ctx(dir));
  const edit = await tools.edit_file.execute(
    { path: 'f.txt', old_string: 'gamma', new_string: 'G' },
    ctx(dir)
  );
  assert.doesNotMatch(edit, /^Error/);
  assert.equal(await fs.readFile(path.join(dir, 'f.txt'), 'utf8'), 'alpha\nbeta\nG\n');
});
