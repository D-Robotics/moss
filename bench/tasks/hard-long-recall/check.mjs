#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const answers = readFileSync('answers.md', 'utf8').trim().split('\n');
assert.equal(answers.length, 4, `expected exactly 4 lines, got ${answers.length}`);
assert.equal(answers[0].trim(), '551-K', 'line 1: code from fact-13');
assert.equal(answers[1].trim(), 'fossa', 'line 2: animal from fact-41');
assert.equal(answers[2].trim(), 'windhoek', 'line 3: city from fact-66');
assert.equal(answers[3].trim(), 'wisteria', 'line 4: color from fact-82');
console.log('check passed');
