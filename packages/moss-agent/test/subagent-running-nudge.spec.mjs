#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateSubagentRunningNudge,
  findStillRunningBackgroundSubagentIds,
} from '../dist/core/loop/subagent-running-nudge.js';

function sessionStarted(taskId = 'session/sub-abc') {
  return [
    { role: 'user', content: 'fix the bug in the background' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_c',
          name: 'create_subagent',
          input: { task: 'fix auth', background: true },
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
          content: `[Sub-agent task ${taskId}] STARTED\n\nThe sub-agent is running…\n`,
        },
      ],
    },
  ];
}

// No bg subagent
{
  const r = evaluateSubagentRunningNudge({
    messages: [{ role: 'user', content: 'hi' }],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// STARTED without status → fire
{
  const messages = sessionStarted();
  assert.deepEqual(findStillRunningBackgroundSubagentIds(messages), ['session/sub-abc']);
  const r = evaluateSubagentRunningNudge({ messages, attempts: 0 });
  assert.equal(r.fire, true);
  assert.match(r.correction, /subagent_status|wait=true|STARTED/i);
  assert.ok(r.taskIds.includes('session/sub-abc'));
}

// Terminal status → no fire
{
  const messages = [
    ...sessionStarted('session/sub-abc'),
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_s',
          name: 'subagent_status',
          input: { taskId: 'session/sub-abc', wait: true },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_s',
          name: 'subagent_status',
          content: '[Sub-agent task session/sub-abc] SUCCESS\n\nFixed.\n',
        },
      ],
    },
  ];
  assert.deepEqual(findStillRunningBackgroundSubagentIds(messages), []);
  const r = evaluateSubagentRunningNudge({ messages, attempts: 0 });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateSubagentRunningNudge({
    messages: sessionStarted(),
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] subagent-running-nudge');
