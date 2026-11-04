#!/usr/bin/env node
/** A search that stopped at its result cap says so; a complete search does not. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchCodeTool } from '../dist/tools/search-tools.js';

const ctxFor = (workspaceDir) => ({
  workspaceDir,
  sessionKey: 'search-truncation',
  abortSignal: new AbortController().signal,
});

test('search_code: content results that hit the cap are marked truncated', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-cap-'));
  try {
    await fs.writeFile(
      path.join(workspaceDir, 'a.txt'),
      Array.from({ length: 6 }, (_, i) => `TODO ${i + 1}`).join('\n') + '\n'
    );
    const ctx = ctxFor(workspaceDir);

    const capped = await searchCodeTool.execute(
      { pattern: 'TODO', head_limit: 3, output_mode: 'content', context_lines: 0 },
      ctx
    );
    assert.match(capped, /results truncated at 3 lines/);
    assert.match(capped, /raise head_limit \(max 200\)/);
    assert.equal(
      capped.split('\n').filter((line) => /^a\.txt:\d+:> TODO/.test(line)).length,
      3,
      'the cap still bounds the result'
    );

    const complete = await searchCodeTool.execute(
      { pattern: 'TODO', head_limit: 20, output_mode: 'content', context_lines: 0 },
      ctx
    );
    assert.doesNotMatch(complete, /results truncated/);
    assert.equal(complete.split('\n').filter((line) => /^a\.txt:\d+:> TODO/.test(line)).length, 6);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('search_code: files_with_matches and count modes mark a capped file list', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-cap-files-'));
  try {
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(workspaceDir, `f${i}.txt`), 'needle here\n');
    }
    const ctx = ctxFor(workspaceDir);

    const files = await searchCodeTool.execute(
      { pattern: 'needle', head_limit: 2, output_mode: 'files_with_matches' },
      ctx
    );
    assert.match(files, /Files with matches \(2\)/);
    assert.match(files, /results truncated at 2 files/);

    const counts = await searchCodeTool.execute(
      { pattern: 'needle', head_limit: 2, output_mode: 'count' },
      ctx
    );
    assert.match(counts, /results truncated at 2 files/);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
