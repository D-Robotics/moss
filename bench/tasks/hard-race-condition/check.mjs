#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const taskDir = path.dirname(fileURLToPath(import.meta.url));
for (let i = 0; i < 5; i++) {
  const t = spawnSync('node', ['test.js'], { encoding: 'utf8' });
  assert.equal(t.status, 0, `test.js failed on run ${i}:\n${t.stdout}\n${t.stderr}`);
}
const m = await import(pathToFileURL(path.resolve('queue.js')).href);
assert.equal(typeof m.pending, 'function', 'pending() exported');
// hidden: sequential semantics preserved — jobs actually execute
const ran = [];
for (const j of [() => Promise.resolve(ran.push(1)), () => Promise.resolve(ran.push(2))]) m.push(j);
await new Promise((r) => setTimeout(r, 80));
assert.equal(ran.length, 2, 'pushed jobs execute');
assert.equal(
  readFileSync('test.js', 'utf8'),
  readFileSync(path.join(taskDir, 'files', 'test.js'), 'utf8'),
  'test.js must stay unmodified'
);
console.log('check passed');
