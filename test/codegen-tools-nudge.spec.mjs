#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateCodegenToolsNudge } from '../dist/core/loop/codegen-tools-nudge.js';

// No tools yet
{
  const r = evaluateCodegenToolsNudge({
    userText: 'please run prisma generate',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Codegen ask + tools without generate → fire
{
  const r = evaluateCodegenToolsNudge({
    userText: 'please run prisma generate',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /prisma generate|codegen|generate/i);
}

// Codegen exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'g1',
          name: 'exec',
          input: { command: 'npx prisma generate' },
        },
      ],
    },
  ];
  const r = evaluateCodegenToolsNudge({
    userText: 'generate the client',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateCodegenToolsNudge({
    userText: 'What is prisma generate?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateCodegenToolsNudge({
    userText: 'run graphql-codegen',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] codegen-tools-nudge');
