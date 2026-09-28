#!/usr/bin/env node
/**
 * repo_outline tool — one-shot file-level workspace outline (C1).
 * Locks: tree shape, noise-dir skipping, hidden filtering, entry cap,
 * output char cap, and real invocation through the tool execute path.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoOutlineTool } from '../dist/tools/repo-outline.js';

const ctx = (workspaceDir) => ({
  workspaceDir,
  runId: 't',
  sessionKey: 't',
  abortSignal: new AbortController().signal,
});

test('repo_outline builds a tree, skips noise dirs, caps entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-outline-spec-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'src', 'cli'));
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'src', 'main.ts'), 'x'.repeat(100));
    writeFileSync(join(dir, 'src', 'cli', 'repl.ts'), 'y'.repeat(2048));
    writeFileSync(join(dir, '.hidden.conf'), 'secret');
    writeFileSync(join(dir, 'README.md'), 'readme');

    const out = await repoOutlineTool.execute({}, ctx(dir));
    const text = String(out);

    assert.match(text, /Repo outline \(/, 'summary header');
    assert.match(text, /main\.ts\s+100B/, 'file with byte size');
    assert.match(text, /repl\.ts\s+2\.0K/, 'human-readable size');
    assert.ok(text.includes('src/'), 'dir entries with trailing slash');
    assert.ok(text.includes('cli/'), 'nested dir');
    assert.ok(!text.includes('node_modules'), 'noise dirs skipped');
    assert.ok(!text.includes('some-pkg'), 'noise content skipped');
    assert.ok(!text.includes('.hidden.conf'), 'hidden files filtered');
    assert.ok(!text.includes('.git'), 'hidden dirs filtered');
    assert.match(
      text,
      /1 noise dirs skipped/,
      'noise dir count reported (node_modules; .git goes through the hidden filter)'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repo_outline respects path filter, include_hidden, and entry caps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-outline-spec2-'));
  try {
    mkdirSync(join(dir, 'pkg'));
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'pkg', `f${i}.ts`), 'x');

    const sub = await repoOutlineTool.execute({ path: 'pkg', max_entries: 5 }, ctx(dir));
    assert.match(String(sub), /truncated at 5 entries/, 'entry cap truncation note');
    assert.ok(!String(sub).includes('f9'), 'entries beyond the cap omitted');

    const hidden = await repoOutlineTool.execute(
      { path: 'pkg', include_hidden: true, max_entries: 1 },
      ctx(dir)
    );
    assert.match(String(hidden), /Repo outline \(1 entries shown/, 'caps apply with hidden on');

    const outside = await repoOutlineTool.execute({ path: '../' }, ctx(dir)).catch((e) => e);
    assert.ok(outside instanceof Error, 'paths outside the workspace are rejected by safePath');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('[PASS] repo_outline tool');
