// O97: an edit rejected for partial-read scope must carry the full current
// file (exactly as read_file presents it) so the next edit succeeds —
// without loosening the read-scope check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readFileTool, editFileTool, writeFileTool } from '../dist/tools/file-tools.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';
import { truncateToolOutput } from '../dist/context/tool-output-truncate.js';
import {
  elideOldLargeToolResults,
  TOOL_RESULT_ELIDED_MARKER,
} from '../dist/context/tool-result-elision.js';

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
const edit20 = { path: 'big.ts', old_string: 'line_20\n', new_string: 'line_20_fixed\n' };

test('partial read: edit is still rejected and the file is untouched', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  const out = await editFileTool.execute(edit20, ctx(dir));
  assert.match(out, /^Error: You only read a partial window of big\.ts \(1:5\)/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), BODY);
});

test('partial read rejection includes the full current file content', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  const out = await editFileTool.execute(edit20, ctx(dir));
  assert.match(out, /\[full file: big\.ts\]/);
  assert.match(out, /\s20\tline_20\n/);
  assert.match(out, /\s40\tline_40/);
});

test('after the rejection the next edit succeeds and state is a full read', async (t) => {
  const dir = await setup(t, BODY);
  const abs = path.join(dir, 'big.ts');
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  assert.match(await editFileTool.execute(edit20, ctx(dir)), /partial window/);
  // Same file state as a full read_file: the full-window reuse state is fresh.
  assert.equal(await globalToolStateManager.readReuseState(abs, 'full'), 'fresh');
  const ok = await editFileTool.execute(edit20, ctx(dir));
  assert.match(ok, /Edited/);
  assert.match(await fs.readFile(abs, 'utf8'), /^line_20_fixed$/m);
});

test('write_file after partial read: rejected with content, then the write succeeds', async (t) => {
  const dir = await setup(t, BODY);
  await readFileTool.execute({ path: 'big.ts', offset: 3, limit: 2 }, ctx(dir));
  const blocked = await writeFileTool.execute({ path: 'big.ts', content: 'x\n' }, ctx(dir));
  assert.match(blocked, /partial window/);
  assert.match(blocked, /\s40\tline_40/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), BODY);
  const ok = await writeFileTool.execute({ path: 'big.ts', content: 'x\n' }, ctx(dir));
  assert.match(ok, /Successfully wrote/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), 'x\n');
});

test('write_file creating a new file is unaffected', async (t) => {
  const dir = await setup(t, BODY);
  const ok = await writeFileTool.execute({ path: 'fresh.ts', content: 'new\n' }, ctx(dir));
  assert.match(ok, /Successfully wrote/);
  assert.doesNotMatch(ok, /partial window|full file/);
  assert.equal(await fs.readFile(path.join(dir, 'fresh.ts'), 'utf8'), 'new\n');
});

test('attached content is redacted like read_file (fake sk- key)', async (t) => {
  const key = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
  const body = `export const a = 1;\nconst OPENAI_API_KEY = "${key}";\nexport const b = 2;\n`;
  const dir = await setup(t, body, 'cfg.ts');
  await readFileTool.execute({ path: 'cfg.ts', offset: 1, limit: 1 }, ctx(dir));
  const out = await editFileTool.execute(
    { path: 'cfg.ts', old_string: 'export const b = 2;', new_string: 'export const b = 3;' },
    ctx(dir)
  );
  assert.match(out, /\[full file: cfg\.ts\]/);
  assert.match(out, /export const b = 2;/);
  assert.ok(!out.includes(key), 'raw key must not reach the model');
  assert.match(out, /OPENAI_API_KEY/);
});

test('partial read of .env then edit: rejection carries no file content', async (t) => {
  const secret = 'hunter2-very-secret-value';
  const dir = await setup(t, `A=1\nDB_PASSWORD=${secret}\nC=3\n`, '.env');
  await readFileTool.execute({ path: '.env', offset: 1, limit: 1 }, ctx(dir));
  const step = { path: '.env', old_string: 'C=3', new_string: 'C=4' };
  const out = await editFileTool.execute(step, ctx(dir));
  assert.match(out, /partial window/);
  assert.match(out, /not attached for credential files/);
  assert.doesNotMatch(out, /\[full file:/);
  assert.ok(!out.includes(secret));
  assert.doesNotMatch(out, /C=3|A=1/);
  // No content, no size, no first line.
  assert.doesNotMatch(out, /\d+\s*(?:chars|bytes|lines)/i);
  assert.doesNotMatch(out, /DB_PASSWORD|\bA=/);
  assert.doesNotMatch(out, /\[lines /);
  assert.match(await editFileTool.execute(step, ctx(dir)), /partial window/);
});

test('~20k-char file: model receives the full body, not a truncation/elision placeholder', async (t) => {
  const lines = Array.from(
    { length: 400 },
    (_, i) => `const value_${i + 1} = "${'z'.repeat(29)}";`
  );
  const body = lines.join('\n') + '\n';
  assert.ok(body.length >= 19_000 && body.length <= 21_000, `size ${body.length}`);
  const dir = await setup(t, body);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 5 }, ctx(dir));
  const step = { path: 'big.ts', old_string: 'const value_200 =', new_string: 'const fixed_200 =' };
  const out = await editFileTool.execute(step, ctx(dir));
  assert.match(out, /\[full file: big\.ts\]/);
  // The loop's per-tool output budget leaves it intact…
  assert.equal(truncateToolOutput('edit_file', out), out);
  // …and elision leaves the pending batch (results after the last assistant) intact.
  const messages = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'edit_file', input: {} }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', name: 'edit_file', content: out }],
    },
  ];
  const delivered = elideOldLargeToolResults(messages).messages[2].content[0].content;
  assert.equal(delivered, out);
  assert.ok(!delivered.includes(TOOL_RESULT_ELIDED_MARKER));
  for (const n of [1, 200, 400]) assert.ok(delivered.includes(`\t${lines[n - 1]}`), `line ${n}`);
  assert.match(await editFileTool.execute(step, ctx(dir)), /Edited/);
});

test('too-large file: rejection gives guidance, no content, stays locked', async (t) => {
  const body = ('x'.repeat(120) + '\n').repeat(1000);
  const dir = await setup(t, body);
  await readFileTool.execute({ path: 'big.ts', offset: 1, limit: 2 }, ctx(dir));
  const step = { path: 'big.ts', old_string: 'x', new_string: 'y' };
  const out = await editFileTool.execute(step, ctx(dir));
  assert.match(out, /partial window/);
  assert.match(out, /too large to attach/);
  assert.doesNotMatch(out, /\[full file:/);
  assert.match(await editFileTool.execute(step, ctx(dir)), /partial window/);
  assert.equal(await fs.readFile(path.join(dir, 'big.ts'), 'utf8'), body);
});

test('refused key/config files leak no content, size, or first line', async (t) => {
  for (const name of ['.apikey-key', 'service.credentials']) {
    const dir = await setup(t, `FIRSTLINE-secret-0123456789\nsecond\n`, name);
    await readFileTool.execute({ path: name, offset: 2, limit: 1 }, ctx(dir));
    const out = await editFileTool.execute(
      { path: name, old_string: 'second', new_string: 'x' },
      ctx(dir)
    );
    assert.match(out, /partial window/, name);
    assert.match(out, /not attached for credential files/, name);
    assert.doesNotMatch(out, /FIRSTLINE|secret-0123|second/, name);
    assert.doesNotMatch(out, /\d+\s*(?:chars|bytes|lines)/i, name);
  }
});
