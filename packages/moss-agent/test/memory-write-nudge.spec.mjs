#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateMemoryWriteNudge } from '../dist/core/loop/memory-write-nudge.js';

// No tools yet
{
  const r = evaluateMemoryWriteNudge({
    userText: 'remember that I prefer short answers',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Remember intent + tools + no write → fire
{
  const r = evaluateMemoryWriteNudge({
    userText: 'remember that I prefer short answers',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /memory_write/i);
}

// Already wrote
{
  const r = evaluateMemoryWriteNudge({
    userText: '记住我喜欢简洁回复',
    toolCallsByName: { memory_write: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Question about memory only
{
  const r = evaluateMemoryWriteNudge({
    userText: 'what do you remember about me?',
    toolCallsByName: { memory_read: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateMemoryWriteNudge({
    userText: 'please remember my timezone is CST',
    toolCallsByName: { exec: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] memory-write-nudge');
