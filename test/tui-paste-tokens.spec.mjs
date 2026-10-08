#!/usr/bin/env node
/** Paste tokens keep the draft, delete as one unit, and expand for the model. */
import assert from 'node:assert/strict';
import {
  deleteText,
  emptyPasteDoc,
  expandPasteTokens,
  insertPaste,
  insertText,
  moveCaret,
} from '../dist/cli/tui/paste-tokens.js';

const body = Array.from({ length: 300 }, (_, index) => `log line ${index + 1}`).join('\n');
let doc = insertText(emptyPasteDoc(), '请看日志：');
doc = insertPaste(doc, body, 1);
doc = insertText(doc, ' 哪里报错？');
const expanded = expandPasteTokens(doc.state.value, doc.tokens);
assert.ok(expanded.startsWith('请看日志：'));
assert.ok(expanded.endsWith(' 哪里报错？'));
assert.equal(expanded.split('\n').length, 300);
assert.match(doc.state.value, /\[Pasted text #1 \+300 lines\]/);
assert.ok(!doc.state.value.includes('log line 300'));

const token = doc.tokens[0];
const once = deleteText(
  { state: { value: doc.state.value, caret: token.end }, tokens: doc.tokens },
  'backward'
);
assert.match(once.state.value, /请看日志：/);
assert.match(once.state.value, /哪里报错？/);
assert.equal(once.tokens.length, 0);
assert.ok(!once.state.value.includes('Pasted text'));

const small = insertPaste(insertText(emptyPasteDoc(), 'a'), 'bc', 2);
assert.equal(small.state.value, 'abc');
assert.equal(small.tokens.length, 0);

let jumped = insertPaste(emptyPasteDoc(), body, 3);
jumped = moveCaret(jumped, 'left');
assert.equal(jumped.state.caret, 0);
