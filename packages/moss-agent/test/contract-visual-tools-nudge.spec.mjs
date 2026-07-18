#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateContractVisualToolsNudge } from '../dist/core/loop/contract-visual-tools-nudge.js';

// No tools yet
{
  const r = evaluateContractVisualToolsNudge({
    userText: 'please run chromatic visual tests',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Visual ask + tools without chromatic → fire
{
  const r = evaluateContractVisualToolsNudge({
    userText: 'please run chromatic visual tests',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /chromatic|pact|visual|run_tests/i);
}

// Contract/pact ask
{
  const r = evaluateContractVisualToolsNudge({
    userText: 'run pact contract tests',
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
          id: 'c1',
          name: 'exec',
          input: { command: 'npx chromatic --project-token=x' },
        },
      ],
    },
  ];
  const r = evaluateContractVisualToolsNudge({
    userText: 'run visual regression',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// run_tests counts
{
  const r = evaluateContractVisualToolsNudge({
    userText: 'contract tests please',
    toolCallsByName: { run_tests: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateContractVisualToolsNudge({
    userText: 'What is chromatic?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateContractVisualToolsNudge({
    userText: '跑契约测试',
    toolCallsByName: { search_code: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] contract-visual-tools-nudge');
