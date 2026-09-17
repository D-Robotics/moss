#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateFormatToolsNudge } from '../dist/core/loop/format-tools-nudge.js';

// No tools yet
{
  const r = evaluateFormatToolsNudge({
    userText: 'please format the codebase with prettier',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Format ask + tools without format → fire
{
  const r = evaluateFormatToolsNudge({
    userText: 'please format the codebase with prettier',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /prettier|format/i);
}

// Format exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'f1',
          name: 'exec',
          input: { command: 'npx prettier --write .' },
        },
      ],
    },
  ];
  const r = evaluateFormatToolsNudge({
    userText: 'format the code',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateFormatToolsNudge({
    userText: '格式化代码',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] format-tools-nudge');
