#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateMutationFuzzToolsNudge } from '../dist/core/loop/mutation-fuzz-tools-nudge.js';

// No tools yet
{
  const r = evaluateMutationFuzzToolsNudge({
    userText: 'please run stryker mutation tests',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Mutation ask + tools without stryker → fire
{
  const r = evaluateMutationFuzzToolsNudge({
    userText: 'please run stryker mutation tests',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /stryker|mutation|fuzz|run_tests/i);
}

// Fuzz ask
{
  const r = evaluateMutationFuzzToolsNudge({
    userText: 'run cargo fuzz tests',
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
          id: 'm1',
          name: 'exec',
          input: { command: 'npx stryker run' },
        },
      ],
    },
  ];
  const r = evaluateMutationFuzzToolsNudge({
    userText: 'run mutation tests',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// run_tests counts
{
  const r = evaluateMutationFuzzToolsNudge({
    userText: 'fuzz tests please',
    toolCallsByName: { run_tests: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateMutationFuzzToolsNudge({
    userText: 'What is mutation testing?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateMutationFuzzToolsNudge({
    userText: '跑变异测试',
    toolCallsByName: { search_code: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] mutation-fuzz-tools-nudge');
