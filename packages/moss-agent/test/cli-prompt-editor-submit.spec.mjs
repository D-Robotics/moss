#!/usr/bin/env node
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { PromptEditor } from '../dist/cli/tui.js';

const submitted = [];
function ControlledEditor() {
  const [value, setValue] = React.useState('');
  return React.createElement(PromptEditor, {
    value,
    cursor: value.length,
    onChange: setValue,
    onSubmit: (nextValue) => submitted.push(nextValue),
    placeholder: 'Ask Moss',
    disabled: false,
  });
}

const editor = render(React.createElement(ControlledEditor));

editor.stdin.write('/btw what files are relevant?');
await new Promise((resolve) => setTimeout(resolve, 25));
editor.stdin.write('\r');
await new Promise((resolve) => setTimeout(resolve, 25));
editor.unmount();

assert.deepEqual(
  submitted,
  ['/btw what files are relevant?'],
  'Enter submits a complete parameterized command instead of the slash-menu template',
);

console.log('[PASS] PromptEditor submits complete parameterized commands');

const coalescedSubmitted = [];
function CoalescedEditor() {
  const [value, setValue] = React.useState('');
  return React.createElement(PromptEditor, {
    value,
    cursor: value.length,
    onChange: setValue,
    onSubmit: (nextValue) => coalescedSubmitted.push(nextValue),
    placeholder: 'Ask Moss',
    disabled: false,
  });
}

const coalesced = render(React.createElement(CoalescedEditor));
coalesced.stdin.write('/connect root@192.168.127.10 --no-verify\r');
await new Promise((resolve) => setTimeout(resolve, 25));
coalesced.unmount();

assert.deepEqual(
  coalescedSubmitted,
  ['/connect root@192.168.127.10 --no-verify'],
  'a pasted command and coalesced Enter must submit in one action',
);

console.log('[PASS] PromptEditor submits coalesced paste + Enter input');
