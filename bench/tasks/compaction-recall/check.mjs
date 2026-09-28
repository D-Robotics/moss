#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lines = readFileSync('answers.md', 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0);
assert.equal(lines.length, 3, 'answers.md must have exactly three lines');
assert.match(lines[0], /FQ-0314/, 'line 1 must be the fact-03 code');
assert.match(lines[1], /amber/, 'line 2 must be the fact-17 color');
assert.match(lines[2], /Delft/, 'line 3 must be the fact-20 city');
console.log('check passed');
