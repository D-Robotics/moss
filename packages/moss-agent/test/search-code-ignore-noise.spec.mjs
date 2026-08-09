#!/usr/bin/env node
/**
 * search_code / search_files JS-walk fallback must skip moss session logs and
 * other generated noise, otherwise session transcripts (which contain the very
 * strings agents search for) crowd out real source matches. rg skips these via
 * .gitignore; the JS-walk fallback (used when rg is unavailable) must stay at
 * parity through IGNORE_DIRS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { grepWalk, walkMatch } from '../dist/tools/search-tools.js';

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-ignore-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, '.moss', 'sessions'), { recursive: true });
  await fs.mkdir(path.join(dir, 'coverage'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'foo.ts'), 'export const FINDME = 1;\n');
  await fs.writeFile(
    path.join(dir, '.moss', 'sessions', 'log.jsonl'),
    'FINDME was searched before — logged in the session transcript\n'
  );
  await fs.writeFile(path.join(dir, 'coverage', 'lcov.info'), 'FINDME in coverage report\n');
  return dir;
}

test('grepWalk skips .moss session logs and coverage, returns source matches', async () => {
  const dir = await makeWorkspace();
  try {
    const matches = await grepWalk(dir, new RegExp('FINDME'), null, 50, 1024 * 1024, 30_000, dir, {
      outputMode: 'content',
      contextLines: 0,
    });
    assert.ok(matches.length > 0, 'found at least one match');
    assert.ok(
      matches.some((m) => m.includes('foo.ts')),
      'includes src/foo.ts'
    );
    assert.ok(!matches.some((m) => m.includes('.moss')), 'excludes .moss session logs');
    assert.ok(!matches.some((m) => m.includes('coverage')), 'excludes coverage');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('walkMatch skips .moss session logs and coverage when globbing files', async () => {
  const dir = await makeWorkspace();
  try {
    const matches = await walkMatch(dir, '*.ts', 50);
    // Returns absolute paths; normalize to relative for assertions.
    const rel = matches.map((p) => path.relative(dir, p).split(path.sep).join('/'));
    assert.ok(
      rel.some((p) => p.includes('foo.ts')),
      'includes src/foo.ts'
    );
    assert.ok(!rel.some((p) => p.includes('.moss')), 'excludes .moss');
    assert.ok(!rel.some((p) => p.includes('coverage')), 'excludes coverage');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
