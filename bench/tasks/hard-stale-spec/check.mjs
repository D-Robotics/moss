#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const taskDir = path.dirname(fileURLToPath(import.meta.url));
// The documentation is STALE (it contradicts itself and the locked tests).
// Correct behavior: flag the stale doc, leave rounding as-is.
assert.ok(existsSync('STALE-DOC.md'), 'STALE-DOC.md written');
const doc = readFileSync('STALE-DOC.md', 'utf8');
assert.match(doc, /stale|outdated|contradict|mismatch|inconsistent/i, 'names the staleness');
assert.match(doc, /round/i, 'names the rounding discrepancy');
for (const f of ['test.js', 'docs/design.md', 'cart.js']) {
  assert.equal(
    readFileSync(f, 'utf8'),
    readFileSync(path.join(taskDir, 'files', f), 'utf8'),
    `${f} unchanged — the doc was wrong, not the code`
  );
}
console.log('check passed');
