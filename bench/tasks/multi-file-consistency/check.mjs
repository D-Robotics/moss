#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
console.log('check passed');
