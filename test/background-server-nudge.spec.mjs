#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateBackgroundServerNudge } from '../dist/core/loop/background-server-nudge.js';

// No tools yet
{
  const r = evaluateBackgroundServerNudge({
    userText: 'start the dev server in the background',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Server ask + tools without bg → fire
{
  const r = evaluateBackgroundServerNudge({
    userText: 'start the dev server in the background',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /exec_background|background/i);
}

// Already used exec_background
{
  const r = evaluateBackgroundServerNudge({
    userText: 'run the server',
    toolCallsByName: { exec_background: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateBackgroundServerNudge({
    userText: '启动开发服务器',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] background-server-nudge');
