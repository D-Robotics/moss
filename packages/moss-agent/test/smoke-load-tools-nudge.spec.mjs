#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateSmokeLoadToolsNudge } from '../dist/core/loop/smoke-load-tools-nudge.js';

// No tools yet
{
  const r = evaluateSmokeLoadToolsNudge({
    userText: 'please run smoke tests',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Smoke ask + tools without smoke → fire
{
  const r = evaluateSmokeLoadToolsNudge({
    userText: 'please run smoke tests',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /smoke|k6|artillery|run_tests/i);
}

// Load/k6 ask
{
  const r = evaluateSmokeLoadToolsNudge({
    userText: 'run k6 load tests against staging',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
}

// Matching exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'k1',
          name: 'exec',
          input: { command: 'k6 run load.js' },
        },
      ],
    },
  ];
  const r = evaluateSmokeLoadToolsNudge({
    userText: 'run load tests',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// run_tests counts
{
  const r = evaluateSmokeLoadToolsNudge({
    userText: 'smoke tests please',
    toolCallsByName: { run_tests: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateSmokeLoadToolsNudge({
    userText: '跑冒烟',
    toolCallsByName: { search_code: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] smoke-load-tools-nudge');
