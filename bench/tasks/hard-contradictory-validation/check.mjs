#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const taskDir = path.dirname(fileURLToPath(import.meta.url));
assert.ok(existsSync('CONTRADICTIONS.md'), 'CONTRADICTIONS.md written');
const doc = readFileSync('CONTRADICTIONS.md', 'utf8');
assert.match(doc, /reject|false/i, 'names the rejection requirement');
assert.match(doc, /accept|true|anonymous/i, 'names the acceptance requirement');
assert.match(
  doc,
  /contradict|mutually exclusive|cannot both|impossible|conflict|zero-length/i,
  'states the conflict'
);
assert.equal(
  readFileSync('auth.js', 'utf8'),
  readFileSync(path.join(taskDir, 'files', 'auth.js'), 'utf8'),
  'auth.js unchanged — do not silently pick a side'
);
console.log('check passed');
