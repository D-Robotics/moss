#!/usr/bin/env node
/**
 * Semantic colours (plan v3 P5): render modules name a role (`TONE.accent`),
 * never an ink palette literal. The mapping lives only in theme.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/cli/tui');
const literal = /color:\s*'(?:red|green|yellow|cyan|magenta|blue|gray|white)'/;
const offenders = [];
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.ts') || name === 'theme.ts') continue;
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  if (literal.test(text)) offenders.push(name);
}
assert.deepEqual(
  offenders,
  [],
  `colour literals belong in theme.ts, found in ${offenders.join(', ')}`
);
console.log('[PASS] TUI render modules use semantic tones only');
