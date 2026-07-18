#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluatePlanToolsNudge } from '../dist/core/loop/plan-tools-nudge.js';

// Too few tools
{
  const r = evaluatePlanToolsNudge({
    userText: 'make a phased migration plan with milestones',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Plan intent + multi tools without plan tools → fire
{
  const r = evaluatePlanToolsNudge({
    userText: 'make a phased migration plan with milestones and execute it',
    toolCallsByName: { read_file: 1, search_code: 1 },
    totalToolCalls: 2,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /plan_step|plan tools|todo_write/i);
}

// Already using plan tools
{
  const r = evaluatePlanToolsNudge({
    userText: 'execute the roadmap',
    toolCallsByName: { plan: 1, read_file: 2 },
    totalToolCalls: 3,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// todo_write already used — skip double-nag
{
  const r = evaluatePlanToolsNudge({
    userText: '分阶段实施重构计划',
    toolCallsByName: { todo_write: 1, read_file: 1 },
    totalToolCalls: 2,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Short conceptual "what's the plan?"
{
  const r = evaluatePlanToolsNudge({
    userText: "what's the plan?",
    toolCallsByName: { read_file: 2 },
    totalToolCalls: 2,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluatePlanToolsNudge({
    userText: 'create an execution plan with milestones',
    toolCallsByName: { read_file: 2 },
    totalToolCalls: 2,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] plan-tools-nudge');
