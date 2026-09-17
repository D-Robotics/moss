#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateStorybookToolsNudge } from '../dist/core/loop/storybook-tools-nudge.js';

// No tools yet
{
  const r = evaluateStorybookToolsNudge({
    userText: 'please start storybook',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Storybook ask + tools without storybook → fire
{
  const r = evaluateStorybookToolsNudge({
    userText: 'please start storybook',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /storybook/i);
}

// Matching exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'exec',
          input: { command: 'npm run storybook' },
        },
      ],
    },
  ];
  const r = evaluateStorybookToolsNudge({
    userText: 'run storybook',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateStorybookToolsNudge({
    userText: 'What is storybook?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateStorybookToolsNudge({
    userText: '启动 storybook',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] storybook-tools-nudge');
