#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const taskDir = path.dirname(fileURLToPath(import.meta.url));
const t = spawnSync('node', ['test.js'], { encoding: 'utf8' });
assert.equal(t.status, 0, `test.js failed:\n${t.stdout}\n${t.stderr}`);
assert.ok(existsSync('vendor/types.js'), 'shared vendor/types.js created');
for (const f of ['test.js']) {
  assert.equal(
    readFileSync(f, 'utf8'),
    readFileSync(path.join(taskDir, 'files', f), 'utf8'),
    `${f} must stay unmodified`
  );
}
for (const f of ['vendor/types-v1.js', 'vendor/types-v2.js']) {
  assert.equal(
    readFileSync(f, 'utf8'),
    readFileSync(path.join(taskDir, 'files', f), 'utf8'),
    `${f} (frozen upstream) must stay unmodified`
  );
}
const legacy = readFileSync('legacy-app.js', 'utf8');
const modern = readFileSync('modern-app.js', 'utf8');
assert.ok(!legacy.includes('types-v1'), 'legacy-app no longer imports v1 directly');
assert.ok(!modern.includes('types-v2'), 'modern-app no longer imports v2 directly');
console.log('check passed');
