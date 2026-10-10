#!/usr/bin/env node
/**
 * `moss --version` appends the build stamp. A missing commit falls back to
 * the package version alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatVersionLine, readBuildStamp } from '../dist/utils/package-info.js';

assert.equal(
  formatVersionLine('unknown', { commit: 'e8dc2e3', date: '2026-10-10' }),
  'moss (unknown version)'
);
assert.equal(
  formatVersionLine('0.26.0', { commit: 'e8dc2e3', date: '2026-10-10' }),
  'moss v0.26.0 (e8dc2e3, 2026-10-10)'
);
assert.equal(formatVersionLine('0.26.0', { commit: 'e8dc2e3' }), 'moss v0.26.0 (e8dc2e3)');
assert.equal(
  formatVersionLine('0.26.0', { commit: 'e8dc2e3', date: '2026-10-10', dirty: true }),
  'moss v0.26.0 (e8dc2e3+dirty, 2026-10-10)'
);
assert.equal(formatVersionLine('0.26.0', { date: '2026-10-10', dirty: true }), 'moss v0.26.0');
assert.equal(formatVersionLine('0.26.0', { date: '2026-10-10' }), 'moss v0.26.0');
assert.equal(formatVersionLine('0.26.0', null), 'moss v0.26.0');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-stamp-'));
  const missing = path.join(dir, 'missing.json');
  assert.equal(readBuildStamp(missing), null);
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '{}\n');
  assert.equal(readBuildStamp(empty), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ commit: 'not-a-commit', date: 'yesterday' }));
  assert.equal(readBuildStamp(bad), null);
  const dateOnly = path.join(dir, 'date.json');
  fs.writeFileSync(dateOnly, JSON.stringify({ date: '2026-10-10' }));
  assert.deepEqual(readBuildStamp(dateOnly), { date: '2026-10-10' });
  const full = path.join(dir, 'full.json');
  fs.writeFileSync(full, JSON.stringify({ commit: 'E8DC2E3', date: '2026-10-10' }));
  assert.deepEqual(readBuildStamp(full), { commit: 'e8dc2e3', date: '2026-10-10' });
  const dirty = path.join(dir, 'dirty.json');
  fs.writeFileSync(dirty, JSON.stringify({ commit: 'e8dc2e3', date: '2026-10-10', dirty: true }));
  assert.deepEqual(readBuildStamp(dirty), { commit: 'e8dc2e3', date: '2026-10-10', dirty: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[PASS] package version stamp');
