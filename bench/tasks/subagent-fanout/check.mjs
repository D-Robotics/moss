#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const expected = ['alpha=ALPHA-7741', 'beta=BETA-3305', 'gamma=GAMMA-9926'];
const lines = readFileSync('tokens.txt', 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0);
assert.deepEqual([...lines].sort(), expected, 'tokens.txt must contain the three name=TOKEN lines');
console.log('check passed');
