#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateAuditToolsNudge } from '../dist/core/loop/audit-tools-nudge.js';

// No tools yet
{
  const r = evaluateAuditToolsNudge({
    userText: 'please run npm audit for security',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Audit ask + tools without audit → fire
{
  const r = evaluateAuditToolsNudge({
    userText: 'please run npm audit for security',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /npm audit|snyk|trivy/i);
}

// Audit exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'a1',
          name: 'exec',
          input: { command: 'npm audit' },
        },
      ],
    },
  ];
  const r = evaluateAuditToolsNudge({
    userText: 'security audit',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateAuditToolsNudge({
    userText: 'What is npm audit?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateAuditToolsNudge({
    userText: '跑 audit',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] audit-tools-nudge');
