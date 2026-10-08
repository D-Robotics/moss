#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadMergedPromptHistory,
  loadPromptHistory,
  mergePromptHistory,
  promptHistoryFile,
  savePromptHistory,
  walkPromptHistory,
} from '../dist/cli/tui/prompt-history.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-hist-'));
const file = promptHistoryFile(dir);
assert.deepEqual(loadPromptHistory(file), []);
savePromptHistory(file, ['one', 'two']);
assert.deepEqual(loadPromptHistory(file), ['one', 'two']);
// A shorter snapshot must not erase older prompts. That used to leave Up
// with a single entry after the next launch.
savePromptHistory(file, ['two']);
assert.deepEqual(loadPromptHistory(file), ['one', 'two']);
savePromptHistory(file, ['three']);
assert.deepEqual(loadPromptHistory(file), ['one', 'two', 'three']);
assert.deepEqual(
  mergePromptHistory([
    ['a', 'b'],
    ['b', 'c'],
  ]),
  ['a', 'b', 'c']
);
assert.deepEqual(loadMergedPromptHistory([file]), ['one', 'two', 'three']);

const cursor = { index: undefined, draft: '' };
const older = walkPromptHistory(['one', 'two', 'three'], cursor, 'older', 'draft');
assert.equal(older.text, 'three');
assert.equal(older.index, 2);
assert.equal(older.draft, 'draft');
const further = walkPromptHistory(['one', 'two', 'three'], older, 'older', 'ignored');
assert.equal(further.text, 'two');
assert.equal(further.index, 1);
const back = walkPromptHistory(['one', 'two', 'three'], { index: 2, draft: 'draft' }, 'newer', '');
assert.equal(back.index, undefined);
assert.equal(back.text, 'draft');
