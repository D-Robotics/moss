#!/usr/bin/env node
import assert from 'node:assert/strict';
import { foldReadonlyRows } from '../dist/cli/tui/transcript.js';

const rows = [
  { id: 1, kind: 'tool', text: 'Read(a.ts)', tool: { name: 'read_file' } },
  { id: 2, kind: 'result', text: 'one' },
  { id: 3, kind: 'tool', text: 'Read(b.ts)', tool: { name: 'read_file' } },
  { id: 4, kind: 'result', text: 'two' },
  { id: 5, kind: 'tool', text: 'List(.)', tool: { name: 'list_directory' } },
  { id: 6, kind: 'result', text: 'dir' },
  { id: 7, kind: 'tool', text: 'Write(c.ts)', tool: { name: 'write_file' } },
];

const folded = foldReadonlyRows(rows, false);
assert.equal(folded.length, 2);
assert.match(folded[0].text, /read 2 files/);
assert.match(folded[0].text, /listed 1 directory/);
assert.equal(folded[1].text, 'Write(c.ts)');
assert.equal(foldReadonlyRows(rows, true).length, rows.length);
