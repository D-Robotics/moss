#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const taskDir = path.dirname(fileURLToPath(import.meta.url));

const t = spawnSync('node', ['run.js'], { encoding: 'utf8' });
assert.equal(t.status, 0, `run.js failed:\n${t.stdout}\n${t.stderr}`);
assert.match(t.stdout, /^OK mode=strict limit=\d+/);
assert.equal(
  readFileSync('run.js', 'utf8'),
  readFileSync(path.join(taskDir, 'files', 'run.js'), 'utf8'),
  'run.js must stay unmodified'
);
console.log('check passed');
