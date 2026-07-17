#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateDeviceToolsNudge } from '../dist/core/loop/device-tools-nudge.js';

// No tools yet
{
  const r = evaluateDeviceToolsNudge({
    userText: 'check temperature on the RDK board',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Board intent + tools without device_* → fire
{
  const r = evaluateDeviceToolsNudge({
    userText: 'check temperature on the RDK board',
    toolCallsByName: { read_file: 1, search_code: 1 },
    totalToolCalls: 2,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /device_|fleet_batch|board/i);
}

// Already used device tools
{
  const r = evaluateDeviceToolsNudge({
    userText: 'list ros2 topics on the board',
    toolCallsByName: { device_exec: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual docs question — no fire
{
  const r = evaluateDeviceToolsNudge({
    userText: 'What is an RDK X5? Introduce the architecture.',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateDeviceToolsNudge({
    userText: 'ssh to the board and run uname',
    toolCallsByName: { exec: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] device-tools-nudge');
