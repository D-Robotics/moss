#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateWebToolsNudge } from '../dist/core/loop/web-tools-nudge.js';

// No tools yet
{
  const r = evaluateWebToolsNudge({
    userText: 'search the web for D-Robotics RDK news',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Web research + tools without web_* → fire
{
  const r = evaluateWebToolsNudge({
    userText: 'search the web for D-Robotics RDK news',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /web_search|web_fetch/i);
}

// Already used web tools
{
  const r = evaluateWebToolsNudge({
    userText: 'look up the official docs online',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateWebToolsNudge({
    userText: '联网搜一下最新新闻',
    toolCallsByName: { exec: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] web-tools-nudge');
