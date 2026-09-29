#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const taskDir = path.dirname(fileURLToPath(import.meta.url));
const t = spawnSync('node', ['test.js'], { encoding: 'utf8' });
assert.equal(t.status, 0, `test.js failed:\n${t.stdout}\n${t.stderr}`);
// hidden acceptance: the dedupe must be GONE, not special-cased
const m = await import(pathToFileURL(path.resolve('stats.js')).href);
assert.equal(m.total([5, 5, 5, 5]), 20, 'four equal scores all count');
assert.equal(m.total([2, 2, 3, 3]), 10, 'duplicate pairs all count');
assert.equal(m.total([]), 0);
const src = readFileSync('stats.js', 'utf8');
assert.equal(
  readFileSync('test.js', 'utf8'),
  readFileSync(path.join(taskDir, 'files', 'test.js'), 'utf8'),
  'test.js must stay unmodified'
);
console.log('check passed');
