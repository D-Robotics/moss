#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateEvalToolsNudge } from '../dist/core/loop/eval-tools-nudge.js';

// No tools yet
{
  const r = evaluateEvalToolsNudge({
    userText: 'run the evaluation suite for this agent',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Eval ask + tools without eval → fire
{
  const r = evaluateEvalToolsNudge({
    userText: 'run the evaluation suite for this agent',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /eval|benchmark|scores/i);
}

// Already used eval
{
  const r = evaluateEvalToolsNudge({
    userText: '跑一下评测套件',
    toolCallsByName: { eval: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateEvalToolsNudge({
    userText: 'What is an evaluation suite?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateEvalToolsNudge({
    userText: 'run the benchmark suite',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] eval-tools-nudge');
