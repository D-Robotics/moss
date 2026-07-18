#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateCodegraphToolsNudge } from '../dist/core/loop/codegraph-tools-nudge.js';

// No tools yet
{
  const r = evaluateCodegraphToolsNudge({
    userText: 'who calls AuthService? show callers in the call graph',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Callers ask + tools without codegraph → fire
{
  const r = evaluateCodegraphToolsNudge({
    userText: 'who calls AuthService? show callers in the call graph',
    toolCallsByName: { search_code: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /codegraph_|call graph|search_code/i);
}

// Already used codegraph
{
  const r = evaluateCodegraphToolsNudge({
    userText: 'find callees of runAgent',
    toolCallsByName: { codegraph_callees: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Conceptual only
{
  const r = evaluateCodegraphToolsNudge({
    userText: 'What is a call graph?',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateCodegraphToolsNudge({
    userText: 'trace impact of changing AuthService',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] codegraph-tools-nudge');
