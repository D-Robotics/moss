#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluatePublishDeployToolsNudge } from '../dist/core/loop/publish-deploy-tools-nudge.js';

// No tools yet
{
  const r = evaluatePublishDeployToolsNudge({
    userText: 'please npm publish the package',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Publish ask + tools without publish exec → fire
{
  const r = evaluatePublishDeployToolsNudge({
    userText: 'please npm publish the package',
    toolCallsByName: { edit_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /npm publish|deploy/i);
}

// Deploy ask
{
  const r = evaluatePublishDeployToolsNudge({
    userText: 'deploy to production now',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
}

// Matching exec already present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'p1',
          name: 'exec',
          input: { command: 'npm publish --access public' },
        },
      ],
    },
  ];
  const r = evaluatePublishDeployToolsNudge({
    userText: 'publish the package',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual how-to without "please/now"
{
  const r = evaluatePublishDeployToolsNudge({
    userText: 'How do I publish an npm package?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluatePublishDeployToolsNudge({
    userText: 'ship to production',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] publish-deploy-tools-nudge');
