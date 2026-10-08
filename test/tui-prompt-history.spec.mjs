#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPromptHistory,
  promptHistoryFile,
  savePromptHistory,
} from '../dist/cli/tui/prompt-history.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-hist-'));
const file = promptHistoryFile(dir);
assert.deepEqual(loadPromptHistory(file), []);
savePromptHistory(file, ['one', 'two']);
assert.deepEqual(loadPromptHistory(file), ['one', 'two']);
savePromptHistory(file, ['two']);
assert.deepEqual(loadPromptHistory(file), ['two']);
