#!/usr/bin/env node
/**
 * search_files / search_code default to the workspace. Every path is searched.
 * Only a recursive scan of `/` or `$HOME` is depth-, time-, and result-capped.
 * Matches go through redactEgress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BROAD_SEARCH_LIMITS,
  resolveSearchLocation,
  searchCodeTool,
  searchFilesTool,
  walkMatch,
} from '../dist/tools/search-tools.js';

const ROOT_NOTE =
  'Note: recursive search of / is bounded (depth <= 2, 8s, <= 40 results). Narrow the path to the workspace for a full search.';
const HOME_NOTE =
  'Note: recursive search of $HOME is bounded (depth <= 3, 8s, <= 40 results). Narrow the path to the workspace for a full search.';

test('resolveSearchLocation: workspace is unbounded; / and $HOME are capped', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-root-'));
  try {
    const omitted = resolveSearchLocation(undefined, ws);
    const dotted = resolveSearchLocation('.', ws);
    assert.equal(omitted.bound, null);
    assert.equal(dotted.bound, null);
    assert.equal(omitted.dir, path.resolve(ws));
    assert.equal(dotted.dir, path.resolve(ws));

    const inside = resolveSearchLocation('src', ws);
    assert.equal(inside.bound, null);

    const root = resolveSearchLocation('/', ws);
    assert.equal(root.dir, path.parse(root.dir).root);
    assert.equal(root.bound.label, '/');
    assert.equal(root.bound.maxDepth, BROAD_SEARCH_LIMITS.filesystemRoot.maxDepth);
    assert.equal(root.bound.note, ROOT_NOTE);

    const home = resolveSearchLocation('$HOME', ws);
    assert.equal(home.bound.label, '$HOME');
    assert.equal(home.bound.maxDepth, BROAD_SEARCH_LIMITS.home.maxDepth);
    assert.equal(home.bound.note, HOME_NOTE);
    const tilde = resolveSearchLocation('~', ws);
    assert.equal(tilde.bound.label, '$HOME');
    assert.equal(tilde.dir, home.dir);
    const braced = resolveSearchLocation('${HOME}', ws);
    assert.equal(braced.dir, home.dir);

    const etc = resolveSearchLocation('/etc', ws);
    assert.equal(etc.bound, null);
    assert.equal(etc.dir, path.resolve('/etc'));
    const nestedHome = resolveSearchLocation('$HOME/moss-not-a-workspace', ws);
    assert.equal(nestedHome.bound, null);
    assert.notEqual(nestedHome.dir, home.dir);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('walkMatch honors maxDepth', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-depth-'));
  try {
    await fs.mkdir(path.join(ws, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(ws, 'keep.txt'), 'keep\n');
    await fs.writeFile(path.join(ws, 'a', 'mid.txt'), 'mid\n');
    await fs.writeFile(path.join(ws, 'a', 'b', 'deep.txt'), 'deep\n');
    const matches = await walkMatch(ws, '*.txt', 20, { maxDepth: 1 });
    const rel = matches.map((file) => path.relative(ws, file).split(path.sep).join('/'));
    assert.ok(rel.includes('keep.txt'));
    assert.ok(rel.includes('a/mid.txt'));
    assert.ok(!rel.includes('a/b/deep.txt'));
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('a path outside the workspace is searched and redacted', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-ws-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-out-'));
  const secret = 'abcd1234efgh5678';
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), `API_KEY=${secret}\n`);
    const location = resolveSearchLocation(outside, ws);
    assert.equal(location.bound, null);
    const ctx = { workspaceDir: ws };
    const files = await searchFilesTool.execute({ pattern: 'secret.txt', path: outside }, ctx);
    const code = await searchCodeTool.execute({ pattern: 'API_KEY', path: outside }, ctx);
    assert.match(files, /secret\.txt/);
    assert.match(code, /secret\.txt/);
    assert.match(code, /\[REDACTED\]/);
    assert.equal(code.includes(secret), false);
    assert.doesNotMatch(files, /bounded/);
    assert.doesNotMatch(code, /bounded/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('workspace search is not marked bounded', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-ws-'));
  try {
    await fs.writeFile(path.join(ws, 'needle.txt'), 'moss-search-needle\n');
    const ctx = { workspaceDir: ws };
    const files = await searchFilesTool.execute({ pattern: 'needle.txt' }, ctx);
    const code = await searchCodeTool.execute({ pattern: 'moss-search-needle' }, ctx);
    assert.match(files, /needle\.txt/);
    assert.match(code, /needle\.txt/);
    assert.doesNotMatch(files, /bounded/);
    assert.doesNotMatch(code, /bounded/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test(
  'search of / and $HOME returns the bound note and stays within the time cap',
  { timeout: 30_000 },
  async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-broad-'));
    const ctx = { workspaceDir: ws };
    const started = Date.now();
    try {
      const [files, code, home] = await Promise.all([
        searchFilesTool.execute({ pattern: 'moss-no-such-glob-9f3a2c', path: '/' }, ctx),
        searchCodeTool.execute({ pattern: 'moss-no-such-token-9f3a2c', path: '/' }, ctx),
        searchFilesTool.execute({ pattern: 'moss-no-such-glob-9f3a2c', path: '$HOME' }, ctx),
      ]);
      assert.ok(files.includes(ROOT_NOTE), files);
      assert.ok(code.includes(ROOT_NOTE), code);
      assert.ok(home.includes(HOME_NOTE), home);
      assert.ok(Date.now() - started < 25_000, 'broad searches must finish under the caps');
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  }
);
