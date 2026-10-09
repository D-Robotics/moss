#!/usr/bin/env node
/**
 * P2-3: the plan-approval gate stays off unless MOSS_PLAN_GATE=1.
 * The A/B that could turn it on was not run in this environment.
 */
import assert from 'node:assert/strict';

import { ToolRegistry } from '../dist/core/tools/tool-registry.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';
import { exitPlanTool, planGateEnabled } from '../dist/tools/plan-gate.js';

assert.equal(planGateEnabled({}), false, 'unset MOSS_PLAN_GATE is off');
assert.equal(planGateEnabled({ MOSS_PLAN_GATE: '0' }), false);
assert.equal(planGateEnabled({ MOSS_PLAN_GATE: '' }), false);
assert.equal(planGateEnabled({ MOSS_PLAN_GATE: '1' }), true, 'only the exact value 1 enables it');

const ctx = { workspaceDir: process.cwd(), sessionKey: 'plan-gate-spec' };
const off = await exitPlanTool.execute({ summary: 'rename the parser' }, ctx);
assert.match(off, /Plan gate is off/);
assert.match(off, /rename the parser/);

const previous = process.env.MOSS_PLAN_GATE;
process.env.MOSS_PLAN_GATE = '1';
try {
  const on = await exitPlanTool.execute({ summary: 'rename the parser' }, ctx);
  assert.match(on, /Wait for the user before editing files/);
} finally {
  if (previous === undefined) delete process.env.MOSS_PLAN_GATE;
  else process.env.MOSS_PLAN_GATE = previous;
}

function registeredWithGate(value) {
  const previous = process.env.MOSS_PLAN_GATE;
  if (value === undefined) delete process.env.MOSS_PLAN_GATE;
  else process.env.MOSS_PLAN_GATE = value;
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools({ tools: registry });
    return registry.has('exit_plan');
  } finally {
    if (previous === undefined) delete process.env.MOSS_PLAN_GATE;
    else process.env.MOSS_PLAN_GATE = previous;
  }
}

assert.equal(registeredWithGate(undefined), false, 'the gate-off registry omits exit_plan');
assert.equal(registeredWithGate('1'), true, 'the gate-on registry still has exit_plan');

console.log('[PASS] cli plan gate');
