#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateCoverageToolsNudge } from '../dist/core/loop/coverage-tools-nudge.js';

// No tools yet
{
  const r = evaluateCoverageToolsNudge({
    userText: 'please run coverage with vitest --coverage',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Coverage ask + tools without coverage → fire
{
  const r = evaluateCoverageToolsNudge({
    userText: 'please run coverage with vitest --coverage',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /coverage|c8|nyc/i);
}

// Coverage exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'c1',
          name: 'exec',
          input: { command: 'npx vitest run --coverage' },
        },
      ],
    },
  ];
  const r = evaluateCoverageToolsNudge({
    userText: 'check coverage',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// run_tests counts
{
  const r = evaluateCoverageToolsNudge({
    userText: 'coverage please',
    toolCallsByName: { run_tests: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateCoverageToolsNudge({
    userText: '跑覆盖率',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] coverage-tools-nudge');
