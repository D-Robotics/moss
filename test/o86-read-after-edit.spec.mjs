#!/usr/bin/env node
/**
 * O86: the read reuse stub ("File unchanged since last read … refer to the
 * earlier read") must never be served when the file content changed or when
 * the earlier read body is no longer in context. And the placeholder that
 * replaces a stale read must not tell the model it "did not see" the file.
 *
 * Repro: /workspace/ux/o86-tool-elide-repro.md §2–3 (calc.py Read → Edit → Read).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readFileTool,
  editFileTool,
  writeFileTool,
  moveFileTool,
  execTool,
} from '../dist/tools/builtin.js';
import { applyPatchTool } from '../dist/tools/patch-tool.js';
import * as toolHelpers from '../dist/tools/tool-helpers.js';
const { FILE_UNCHANGED_STUB, globalToolStateManager } = toolHelpers;
// Fallback keeps this file importable when src/ is reverted to main (revert-red check).
const READ_REUSE_HASH_MAX_BYTES = toolHelpers.READ_REUSE_HASH_MAX_BYTES ?? 2 * 1024 * 1024;
import {
  STALE_READ_PLACEHOLDER,
  FILE_UNCHANGED_PLACEHOLDER,
  invalidateStaleReadToolResults,
} from '../dist/context/stale-read-invalidate.js';
import {
  elideOldLargeToolResults,
  TOOL_RESULT_ELIDED_MARKER,
} from '../dist/context/tool-result-elision.js';

const IS_WIN = process.platform === 'win32';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'o86', abortSignal: new AbortController().signal };
}

async function ws(t, files = { 'calc.py': 'def add(a, b):\n    return a - b\n' }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o86-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

const read = (dir, p, extra = {}) => readFileTool.execute({ path: p, ...extra }, ctx(dir));

// ── A: four mutation tools ────────────────────────────────────────────────
test('A1 edit: first read after edit is real, second is the stub (repro §3.1)', async (t) => {
  const dir = await ws(t);
  assert.match(await read(dir, 'calc.py'), /return a - b/);
  const out = await editFileTool.execute(
    { path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' },
    ctx(dir)
  );
  assert.doesNotMatch(String(out), /^Error/);
  const second = await read(dir, 'calc.py');
  assert.notEqual(second, FILE_UNCHANGED_STUB);
  assert.match(second, /return a \+ b/);
  assert.equal(await read(dir, 'calc.py'), FILE_UNCHANGED_STUB, 'token win kept');
});

test('A2 write_file: first read after write is real, second is the stub', async (t) => {
  const dir = await ws(t);
  await read(dir, 'calc.py');
  await writeFileTool.execute({ path: 'calc.py', content: 'print(5)\n' }, ctx(dir));
  const r = await read(dir, 'calc.py');
  assert.notEqual(r, FILE_UNCHANGED_STUB);
  assert.match(r, /print\(5\)/);
  assert.equal(await read(dir, 'calc.py'), FILE_UNCHANGED_STUB);
});

test('A3 apply_patch: first read after patch is real, second is the stub', async (t) => {
  const dir = await ws(t);
  await read(dir, 'calc.py');
  const patch = [
    '*** Begin Patch',
    '*** Update File: calc.py',
    '@@',
    '-    return a - b',
    '+    return a + b',
    '*** End Patch',
  ].join('\n');
  const out = await applyPatchTool.execute({ patch }, ctx(dir));
  assert.doesNotMatch(String(out), /^Error/);
  const r = await read(dir, 'calc.py');
  assert.notEqual(r, FILE_UNCHANGED_STUB);
  assert.match(r, /return a \+ b/);
  assert.equal(await read(dir, 'calc.py'), FILE_UNCHANGED_STUB);
});

test('A4 move_file: first read of the destination is real, second is the stub', async (t) => {
  const dir = await ws(t, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  await read(dir, 'a.txt');
  await read(dir, 'b.txt');
  const out = await moveFileTool.execute(
    { source: 'a.txt', destination: 'b.txt', overwrite: true },
    ctx(dir)
  );
  assert.doesNotMatch(String(out), /^Error/);
  const r = await read(dir, 'b.txt');
  assert.notEqual(r, FILE_UNCHANGED_STUB);
  assert.match(r, /alpha/);
  assert.equal(await read(dir, 'b.txt'), FILE_UNCHANGED_STUB);
});

// ── Q1: shell / external edits, including same size and same mtime ───────
// already correct on main; regression guard (在 main 上本来就对，用来防回退)
test(
  'Q1a shell edit (sed -i style, via exec) then read is real',
  { skip: IS_WIN && 'platform mismatch (POSIX shell)' },
  async (t) => {
    const dir = await ws(t, { 'f.txt': 'a\n' });
    await read(dir, 'f.txt');
    await execTool.execute({ command: "printf 'b\\n' > f.txt" }, ctx(dir));
    const r = await read(dir, 'f.txt');
    assert.notEqual(r, FILE_UNCHANGED_STUB);
    assert.match(r, /b/);
  }
);

test('Q1b same size + same mtime external change still serves real content', async (t) => {
  const dir = await ws(t, { 'f.txt': 'a\n' });
  const file = path.join(dir, 'f.txt');
  await read(dir, 'f.txt');
  const before = fss.statSync(file);
  fss.writeFileSync(file, 'b\n'); // same size
  fss.utimesSync(file, before.atime, before.mtime); // coarse-mtime filesystem / same tick
  const r = await read(dir, 'f.txt');
  assert.notEqual(r, FILE_UNCHANGED_STUB, 'content changed: never the stub');
  assert.match(r, /b/);
});

// ── Q2: failed edits ──────────────────────────────────────────────────────
// already correct on main; regression guard (在 main 上本来就对，用来防回退)
test('Q2a failed edit (old_string miss) does not mark the file changed', async (t) => {
  const dir = await ws(t);
  await read(dir, 'calc.py');
  const out = await editFileTool.execute(
    { path: 'calc.py', old_string: 'no such text', new_string: 'x' },
    ctx(dir)
  );
  assert.match(String(out), /Error|not found|did not match/i);
  const r = await read(dir, 'calc.py');
  // main already drops read credit after a miss → real content; keep that.
  assert.match(r, /return a - b/);
});

test('Q2b failed mutation does not swap the earlier read for the "written" placeholder', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'calc.py' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'BODY' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'e1',
          name: 'edit_file',
          input: { path: 'calc.py', old_string: 'x', new_string: 'y' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'e1',
          is_error: true,
          content: 'Error: old_string not found in calc.py',
        },
      ],
    },
  ];
  const out = invalidateStaleReadToolResults(messages);
  const body = out.messages[1].content[0].content;
  assert.notEqual(
    body,
    STALE_READ_PLACEHOLDER,
    'no "written successfully" claim after a failed edit'
  );
  assert.equal(body, 'BODY');
});

// ── Q3: path aliases ──────────────────────────────────────────────────────
for (const [label, editPath] of [
  ['./ prefix', './calc.py'],
  ['absolute', null],
]) {
  test(
    `Q3 edit via ${label}, read via plain relative path is real`,
    { skip: label === 'symlink' && IS_WIN && 'platform mismatch (symlink)' },
    async (t) => {
      const dir = await ws(t);
      if (label === 'symlink')
        await fs.symlink(path.join(dir, 'calc.py'), path.join(dir, 'link.py'));
      await read(dir, 'calc.py');
      const p = editPath ?? path.join(dir, 'calc.py');
      await read(dir, p);
      const out = await editFileTool.execute(
        { path: p, old_string: 'return a - b', new_string: 'return a + b' },
        ctx(dir)
      );
      assert.doesNotMatch(String(out), /^Error/);
      const r = await read(dir, 'calc.py');
      assert.notEqual(r, FILE_UNCHANGED_STUB);
      assert.match(r, /return a \+ b/);
    }
  );
}

// already correct on main; regression guard (在 main 上本来就对，用来防回退). Verified on 9468b663 src: link read serves the new body.
test(
  'Q3 symlink: edit via the real path, read via the link is never the stub',
  { skip: IS_WIN && 'platform mismatch (symlink)' },
  async (t) => {
    const dir = await ws(t);
    await fs.symlink(path.join(dir, 'calc.py'), path.join(dir, 'link.py'));
    let viaLink;
    try {
      viaLink = await read(dir, 'link.py');
    } catch (err) {
      viaLink = String(err);
    }
    await read(dir, 'calc.py');
    await editFileTool.execute(
      { path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' },
      ctx(dir)
    );
    let after;
    try {
      after = await read(dir, 'link.py');
    } catch (err) {
      after = String(err);
    }
    assert.notEqual(after, FILE_UNCHANGED_STUB, 'content changed: never the stub via the alias');
    // The read via the link must serve the new body, not an error or stale content.
    assert.match(after, /return a \+ b/, after);
    assert.doesNotMatch(after, /return a - b/, after);
    void viaLink;
  }
);

// ── Q4: partial read after edit does not count as seeing the full file ────
// already correct on main; regression guard (在 main 上本来就对，用来防回退)
test('Q4 edit → partial read → full read: full read is real', async (t) => {
  const dir = await ws(t);
  await read(dir, 'calc.py');
  await editFileTool.execute(
    { path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' },
    ctx(dir)
  );
  await read(dir, 'calc.py', { offset: 1, limit: 1 });
  const full = await read(dir, 'calc.py');
  assert.notEqual(full, FILE_UNCHANGED_STUB);
  assert.match(full, /return a \+ b/);
});

// ── Q5: sub-agent edits and dropped context ───────────────────────────────
test('Q5a an edit by another agent (separate session, same file) then read is real', async (t) => {
  const dir = await ws(t);
  await read(dir, 'calc.py');
  const child = { ...ctx(dir), sessionKey: 'o86-child' };
  await readFileTool.execute({ path: 'calc.py' }, child);
  await editFileTool.execute(
    { path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' },
    child
  );
  const r = await read(dir, 'calc.py');
  assert.notEqual(r, FILE_UNCHANGED_STUB);
  assert.match(r, /return a \+ b/);
});

test('Q5b after a large read is elided from context, re-read does not say "refer to earlier"', async (t) => {
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const dir = await ws(t, { 'big.txt': big });
  const first = await read(dir, 'big.txt');
  const messages = [];
  for (let i = 0; i < 5; i++) {
    const id = `r${i}`;
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'read_file',
          input: { path: i === 0 ? 'big.txt' : `o${i}.txt` },
        },
      ],
    });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          name: 'read_file',
          content: i === 0 ? first : 'x'.repeat(9000),
        },
      ],
    });
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  const elided = elideOldLargeToolResults(messages);
  assert.ok(elided.elidedCount >= 1, 'fixture: the big read was elided');
  const r = await read(dir, 'big.txt');
  assert.notEqual(
    r,
    FILE_UNCHANGED_STUB,
    'earlier body is gone: never "refer to the earlier read"'
  );
});

// ── B: placeholder wording ────────────────────────────────────────────────
test('B placeholders say the file was written; no "elided"/"not visible" wording', () => {
  for (const text of [STALE_READ_PLACEHOLDER]) {
    assert.doesNotMatch(text, /elided|not visible|didn'?t see|不可见|没看见/i);
    assert.match(text, /编辑并成功写入/);
    assert.match(text, /edited and written successfully/i);
    assert.match(text, /重新读取|re-read/i);
  }
  assert.doesNotMatch(FILE_UNCHANGED_PLACEHOLDER, /elided|不可见|没看见/i);
  assert.doesNotMatch(TOOL_RESULT_ELIDED_MARKER, /elided/i, 'large-result stub has no "elided"');
});

test.after(() => globalToolStateManager.clearFileState());

// ── Size cap: files above the sha256 cap never get the reuse stub ─────────
test('Cap: a file above READ_REUSE_HASH_MAX_BYTES always gets real content (no stub)', async (t) => {
  const line = 'x'.repeat(99) + '\n';
  const big = line.repeat(Math.ceil((READ_REUSE_HASH_MAX_BYTES + 1) / line.length));
  assert.ok(Buffer.byteLength(big) > READ_REUSE_HASH_MAX_BYTES);
  const dir = await ws(t, { 'big.txt': big, 'small.txt': 'hello\n' });
  const first = await read(dir, 'big.txt');
  assert.notEqual(first, FILE_UNCHANGED_STUB);
  const second = await read(dir, 'big.txt');
  assert.notEqual(second, FILE_UNCHANGED_STUB, 'above cap: unchanged re-read is real content');
  assert.equal(second, first);
  // Below the cap the token win is kept.
  await read(dir, 'small.txt');
  assert.equal(await read(dir, 'small.txt'), FILE_UNCHANGED_STUB);
});
