#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateSubagentStoppedNudge,
  hasRecentSubagentStop,
} from '../dist/core/loop/subagent-stopped-nudge.js';

function sessionWithStop() {
  return [
    { role: 'user', content: 'fix the bug in the background' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_c',
          name: 'create_subagent',
          input: { task: 'fix', background: true },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_c',
          name: 'create_subagent',
          content: '[Sub-agent task t1] STARTED\n',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_stop', name: 'subagent_stop', input: { taskId: 't1' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_stop',
          name: 'subagent_stop',
          content: '[Sub-agent task t1] STOPPED\nstatus: cancelled\n',
        },
      ],
    },
  ];
}

assert.equal(hasRecentSubagentStop([{ role: 'user', content: 'hi' }]), false);
assert.equal(hasRecentSubagentStop(sessionWithStop()), true);

// Fire after stop without suite
{
  const r = evaluateSubagentStoppedNudge({
    messages: sessionWithStop(),
    toolCallsByName: { create_subagent: 1, subagent_stop: 1 },
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /subagent_stop|not.*proof|cancelled|run_tests/i);
}

// Parent already ran tests
{
  const r = evaluateSubagentStoppedNudge({
    messages: sessionWithStop(),
    toolCallsByName: { create_subagent: 1, subagent_stop: 1, run_tests: 1 },
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateSubagentStoppedNudge({
    messages: sessionWithStop(),
    toolCallsByName: { subagent_stop: 1 },
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

// No stop tool
{
  const r = evaluateSubagentStoppedNudge({
    messages: sessionWithStop().slice(0, 3),
    toolCallsByName: { create_subagent: 1 },
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] subagent-stopped-nudge');
