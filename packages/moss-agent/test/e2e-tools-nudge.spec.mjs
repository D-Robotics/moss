#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateE2eToolsNudge } from '../dist/core/loop/e2e-tools-nudge.js';

// No tools yet
{
  const r = evaluateE2eToolsNudge({
    userText: 'please run playwright e2e tests',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// E2E ask + tools without e2e → fire
{
  const r = evaluateE2eToolsNudge({
    userText: 'please run playwright e2e tests',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /playwright|e2e|run_tests/i);
}

// Playwright exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'e1',
          name: 'exec',
          input: { command: 'npx playwright test' },
        },
      ],
    },
  ];
  const r = evaluateE2eToolsNudge({
    userText: 'run e2e',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// run_tests counts
{
  const r = evaluateE2eToolsNudge({
    userText: 'run cypress e2e',
    toolCallsByName: { run_tests: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateE2eToolsNudge({
    userText: 'What is playwright?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateE2eToolsNudge({
    userText: '跑 e2e',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] e2e-tools-nudge');
