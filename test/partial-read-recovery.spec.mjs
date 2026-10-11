// O97: an edit rejected for partial-read scope must carry the full current
// file so the next edit succeeds — without loosening the read-scope check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readFileTool, editFileTool, writeFileTool } from '../dist/tools/file-tools.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function setup(t, body, name = 'big.ts') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o97-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, name), body);
  return dir;
}

const BODY = Array.from({ length: 40 }, (_, i) => `line_${i + 1}`).join('\n') + '\n';

test('partial read: edit is still rejected and the file is untouched', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  const out = await editFileTool.execute(
    { path: 'big.ts', old_string: 'line_20', new_string: 'line_20_fixed' },
    ctx(dir)
  );
  assert.match(out, /^Error: You only read a partial window of big\.ts \(1:5\)/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), BODY);
});

test('partial read rejection includes the full current file content', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  const out = await editFileTool.execute(
    { path: 'big.ts', old_string: 'line_20', new_string: 'line_20_fixed' },
    ctx(dir)
  );
  assert.match(out, /\[full file: big\.ts\]/);
  // Lines far outside the paged window are present, line-numbered like read_file.
  assert.match(out, /\s20\tline_20\n/);
  assert.match(out, /\s40\tline_40/);
});

test('after the rejection, the next edit succeeds', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  const blocked = await editFileTool.execute(
    { path: 'big.ts', old_string: 'line_20', new_string: 'line_20_fixed' },
    ctx(dir)
  );
  assert.match(blocked, /partial window/);
  const ok = await editFileTool.execute(
    { path: 'big.ts', old_string: 'line_20\n', new_string: 'line_20_fixed\n' },
    ctx(dir)
  );
  assert.match(ok, /Edited/);
  assert.match(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), /^line_20_fixed$/m);
});

test('write_file after partial read: rejected, carries content, then allowed', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 3, limit: 2 }, ctx(dir));
  const blocked = await writeFileTool.execute({ path: 'big.ts', content: 'x\n' }, ctx(dir));
  assert.match(blocked, /partial window/);
  assert.match(blocked, /\s40\tline_40/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), BODY);
});

test('too-large file: rejection gives guidance, no content, stays locked', async (t) => {
  const big = 'x'.repeat(120) + '\n';
  const body = big.repeat(1000); // ~121k chars > 100k cap
  const dir = await setup(t, body);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 2 }, ctx(dir));
  const out = await editFileTool.execute(
    { path: 'big.ts', old_string: 'x', new_string: 'y' },
    ctx(dir)
  );
  assert.match(out, /partial window/);
  assert.match(out, /too large to include/);
  assert.doesNotMatch(out, /\[full file:/);
  const again = await editFileTool.execute(
    { path: 'big.ts', old_string: 'x', new_string: 'y' },
    ctx(dir)
  );
  assert.match(again, /partial window/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), body);
});
