#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateSeedToolsNudge } from '../dist/core/loop/seed-tools-nudge.js';

// No tools yet
{
  const r = evaluateSeedToolsNudge({
    userText: 'please seed the database',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Seed ask + tools without seed → fire
{
  const r = evaluateSeedToolsNudge({
    userText: 'please seed the database',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /seed|prisma db seed/i);
}

// Seed exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'exec',
          input: { command: 'npx prisma db seed' },
        },
      ],
    },
  ];
  const r = evaluateSeedToolsNudge({
    userText: 'seed the db',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateSeedToolsNudge({
    userText: 'What is database seeding?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateSeedToolsNudge({
    userText: '灌数',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] seed-tools-nudge');
