#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateRunTestsToolsNudge } from '../dist/core/loop/run-tests-tools-nudge.js';

// No tools yet
{
  const r = evaluateRunTestsToolsNudge({
    userText: 'please run the tests',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Explicit run-tests ask + tools without verify → fire (even with zero edits)
{
  const r = evaluateRunTestsToolsNudge({
    userText: 'please run the tests',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /run_tests|verify_fix|npm test/i);
}

// Already ran run_tests
{
  const r = evaluateRunTestsToolsNudge({
    userText: 'run npm test',
    toolCallsByName: { run_tests: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Test-shaped exec already present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'exec',
          input: { command: 'npm test' },
        },
      ],
    },
  ];
  const r = evaluateRunTestsToolsNudge({
    userText: 'run the tests',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// User asked to skip tests
{
  const r = evaluateRunTestsToolsNudge({
    userText: 'run the tests — skip tests actually, docs only',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateRunTestsToolsNudge({
    userText: '跑一下测试',
    toolCallsByName: { search_code: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] run-tests-tools-nudge');
