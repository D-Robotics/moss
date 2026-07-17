#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateMigrateToolsNudge } from '../dist/core/loop/migrate-tools-nudge.js';

// No tools yet
{
  const r = evaluateMigrateToolsNudge({
    userText: 'please run prisma migrate deploy',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Migrate ask + tools without migrate → fire
{
  const r = evaluateMigrateToolsNudge({
    userText: 'please run prisma migrate deploy',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /migrate|prisma/i);
}

// Migrate exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'm1',
          name: 'exec',
          input: { command: 'npx prisma migrate deploy' },
        },
      ],
    },
  ];
  const r = evaluateMigrateToolsNudge({
    userText: 'apply migrations',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateMigrateToolsNudge({
    userText: 'What is a database migration?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateMigrateToolsNudge({
    userText: '跑迁移',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] migrate-tools-nudge');
