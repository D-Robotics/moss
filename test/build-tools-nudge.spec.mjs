#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateBuildToolsNudge } from '../dist/core/loop/build-tools-nudge.js';

// No tools yet
{
  const r = evaluateBuildToolsNudge({
    userText: 'please npm run build the project',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Build ask + tools without build → fire
{
  const r = evaluateBuildToolsNudge({
    userText: 'please npm run build the project',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /build|tsc|verify_fix/i);
}

// Already ran verify_fix
{
  const r = evaluateBuildToolsNudge({
    userText: 'build the package',
    toolCallsByName: { verify_fix: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Build-shaped exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'b1',
          name: 'exec',
          input: { command: 'npm run build' },
        },
      ],
    },
  ];
  const r = evaluateBuildToolsNudge({
    userText: 'build the project',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateBuildToolsNudge({
    userText: 'cargo build the crate',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] build-tools-nudge');
