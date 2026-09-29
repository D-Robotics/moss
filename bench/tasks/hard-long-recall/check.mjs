#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const answers = readFileSync('answers.md', 'utf8').trim().split('\n');
assert.equal(answers.length, 3, `expected exactly 3 lines, got ${answers.length}`);
assert.equal(answers[0].trim(), '417-R', 'line 1: code from fact-07');
assert.equal(answers[1].trim(), 'ibex', 'line 2: animal from fact-23');
assert.equal(answers[2].trim(), 'osaka', 'line 3: city from fact-38');
console.log('check passed');
