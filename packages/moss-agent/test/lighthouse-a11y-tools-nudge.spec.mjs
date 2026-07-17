#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateLighthouseA11yToolsNudge } from '../dist/core/loop/lighthouse-a11y-tools-nudge.js';

// No tools yet
{
  const r = evaluateLighthouseA11yToolsNudge({
    userText: 'please run lighthouse audit',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Lighthouse ask + tools without lighthouse → fire
{
  const r = evaluateLighthouseA11yToolsNudge({
    userText: 'please run lighthouse audit',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /lighthouse|axe|pa11y|a11y/i);
}

// A11y ask
{
  const r = evaluateLighthouseA11yToolsNudge({
    userText: 'run axe accessibility checks',
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
          id: 'l1',
          name: 'exec',
          input: { command: 'npx lighthouse https://example.com' },
        },
      ],
    },
  ];
  const r = evaluateLighthouseA11yToolsNudge({
    userText: 'run lighthouse',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateLighthouseA11yToolsNudge({
    userText: 'What is lighthouse?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateLighthouseA11yToolsNudge({
    userText: '跑无障碍检测',
    toolCallsByName: { search_code: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] lighthouse-a11y-tools-nudge');
