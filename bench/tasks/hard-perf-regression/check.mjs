#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const taskDir = path.dirname(fileURLToPath(import.meta.url));
for (let i = 0; i < 3; i++) {
  const t = spawnSync('node', ['test.js'], { encoding: 'utf8' });
  assert.equal(t.status, 0, `test.js failed on run ${i}:\n${t.stdout}\n${t.stderr}`);
}
for (const f of ['test.js', 'catalog.test.js', 'throughput.test.js']) {
  assert.equal(
    readFileSync(f, 'utf8'),
    readFileSync(path.join(taskDir, 'files', f), 'utf8'),
    `${f} must stay unmodified`
  );
}
const src = readFileSync('catalog.js', 'utf8');
assert.ok(!/concat\(/.test(src), 'no array concat inside the traversal');
assert.ok(
  !/report = report \+/.test(src) && !/report \+=/.test(src),
  'no quadratic string building in summary'
);
console.log('check passed');
