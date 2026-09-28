#!/usr/bin/env node
/**
 * edit-syntax-check post-tool hook (C2) — fast post-edit validation.
 * Locks: broken JS/JSON results get a FAIL appendix; clean files and
 * unsupported extensions stay untouched; non-mutating tools are ignored.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditSyntaxCheckHook } from '../dist/core/tools/edit-syntax-check-hook.js';

const hook = createEditSyntaxCheckHook();
const ctx = (workspaceDir) => ({
  workspaceDir,
  runId: 't',
  sessionKey: 't',
  abortSignal: new AbortController().signal,
});
const tool = (name) => ({ name });

test('broken .js gets a FAIL appendix after write_file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-check-spec-'));
  try {
    writeFileSync(join(dir, 'broken.mjs'), 'const x = {;');
    const out = await hook.process({
      tool: tool('write_file'),
      input: { file_path: 'broken.mjs' },
      result: 'Wrote broken.mjs',
      isError: false,
      durationMs: 5,
      ctx: ctx(dir),
      sessionId: 's',
    });
    assert.ok(out, 'hook rewrites the result');
    assert.match(out.result, /\[post-edit check\] FAIL/, 'FAIL marker appended');
    assert.match(out.result, /broken\.mjs:/, 'failing file named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clean .js and clean .json results pass through untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-check-spec2-'));
  try {
    writeFileSync(join(dir, 'ok.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ a: 1 }));
    for (const file of ['ok.mjs', 'ok.json']) {
      const out = await hook.process({
        tool: tool('edit_file'),
        input: { file_path: file },
        result: 'edited',
        isError: false,
        durationMs: 5,
        ctx: ctx(dir),
        sessionId: 's',
      });
      assert.equal(out, null, `${file} clean → no rewrite`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed .json fails; .ts is skipped; read tools ignored; error results ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-check-spec3-'));
  try {
    writeFileSync(join(dir, 'bad.json'), '{not json');
    const bad = await hook.process({
      tool: tool('edit_file'),
      input: { file_path: 'bad.json' },
      result: 'edited',
      isError: false,
      durationMs: 5,
      ctx: ctx(dir),
      sessionId: 's',
    });
    assert.ok(bad, 'malformed json fails');
    assert.match(bad.result, /bad\.json:/, 'bad.json named');

    writeFileSync(join(dir, 'skip.ts'), 'const broken: = ;');
    const ts = await hook.process({
      tool: tool('edit_file'),
      input: { file_path: 'skip.ts' },
      result: 'edited',
      isError: false,
      durationMs: 5,
      ctx: ctx(dir),
      sessionId: 's',
    });
    assert.equal(ts, null, 'ts files are skipped (no fast checker)');

    const readonlyTool = await hook.process({
      tool: tool('read_file'),
      input: { file_path: 'bad.json' },
      result: 'content',
      isError: false,
      durationMs: 5,
      ctx: ctx(dir),
      sessionId: 's',
    });
    assert.equal(readonlyTool, null, 'non-mutating tools ignored');

    const errored = await hook.process({
      tool: tool('edit_file'),
      input: { file_path: 'bad.json' },
      result: 'Error: something',
      isError: true,
      durationMs: 5,
      ctx: ctx(dir),
      sessionId: 's',
    });
    assert.equal(errored, null, 'failed tool executions are not re-checked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_patch extracts *** Update File paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-check-spec4-'));
  try {
    writeFileSync(join(dir, 'p.mjs'), 'const x = {;');
    const out = await hook.process({
      tool: tool('apply_patch'),
      input: { patch: '*** Begin Patch\n*** Update File: p.mjs\n@@\n-a\n+b\n*** End Patch' },
      result: 'applied',
      isError: false,
      durationMs: 5,
      ctx: ctx(dir),
      sessionId: 's',
    });
    assert.ok(out, 'patch target checked');
    assert.match(out.result, /p\.mjs:/, 'patch file named on failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('[PASS] edit-syntax-check hook');
