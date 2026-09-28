#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const taskDir = path.dirname(fileURLToPath(import.meta.url));

const t = spawnSync('node', ['test.js'], { encoding: 'utf8' });
assert.equal(t.status, 0, `test.js failed:\n${t.stdout}\n${t.stderr}`);
assert.match(t.stdout, /all tests passed/);
assert.equal(
  readFileSync('test.js', 'utf8'),
  readFileSync(path.join(taskDir, 'files', 'test.js'), 'utf8'),
  'test.js must stay unmodified'
);
assert.ok(existsSync('src/util/string-ops.js'), 'unified module src/util/string-ops.js exists');
assert.ok(!existsSync('src/util/string-helpers-a.js'), 'old helper A deleted');
assert.ok(!existsSync('src/util/string-helpers-b.js'), 'old helper B deleted');
const ops = readFileSync('src/util/string-ops.js', 'utf8');
assert.match(ops, /truncateEnd/, 'unified module exports truncateEnd');
assert.match(ops, /padCenter/, 'unified module exports padCenter');
assert.ok(!ops.includes('clip('), 'legacy clip name gone');
console.log('check passed');
