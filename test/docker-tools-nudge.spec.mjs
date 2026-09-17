#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateDockerToolsNudge } from '../dist/core/loop/docker-tools-nudge.js';

// No tools yet
{
  const r = evaluateDockerToolsNudge({
    userText: 'docker compose up the stack',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Docker ask + tools without docker exec → fire
{
  const r = evaluateDockerToolsNudge({
    userText: 'docker compose up the stack',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /docker|podman|compose/i);
}

// Docker exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'd1',
          name: 'exec',
          input: { command: 'docker compose up -d' },
        },
      ],
    },
  ];
  const r = evaluateDockerToolsNudge({
    userText: 'start containers',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateDockerToolsNudge({
    userText: 'What is docker?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateDockerToolsNudge({
    userText: 'build the container image',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] docker-tools-nudge');
