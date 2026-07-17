#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateFanOutNudge,
  findLatestFailedFanOut,
} from '../dist/core/loop/fan-out-nudge.js';

function sessionWithFanOut(resultText, opts = {}) {
  return [
    { role: 'user', content: 'review this PR in parallel' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_fo',
          name: 'fan_out_subagents',
          input: { tasks: [{ task: 'a' }, { task: 'b' }] },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_fo',
          name: 'fan_out_subagents',
          content: resultText,
          ...(opts.is_error ? { is_error: true, outcome: 'error' } : {}),
        },
      ],
    },
  ];
}

// No fan_out → no fire
{
  const r = evaluateFanOutNudge({
    messages: [{ role: 'user', content: 'hi' }],
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// All success → no fire
{
  const r = evaluateFanOutNudge({
    messages: sessionWithFanOut(
      '[fan_out_subagents] 2 sub-agents ran concurrently — 2 ok, 0 failed.\n\n### [a] SUCCESS\nok\n',
    ),
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Failed children → fire once
{
  const text = [
    'Error: [fan_out_subagents] 2 sub-agents ran concurrently — 1 ok, 1 failed.',
    '## Retry failed angles (copy into a new fan_out or create_subagent)',
    '- label="security" scope=explore task="look for XSS"',
  ].join('\n');
  const messages = sessionWithFanOut(text, { is_error: true });
  assert.ok(findLatestFailedFanOut(messages));
  const r = evaluateFanOutNudge({ messages, attempts: 0 });
  assert.equal(r.fire, true);
  assert.match(r.correction, /FAILED|Retry|re-run|SUCCESS/i);

  const r2 = evaluateFanOutNudge({ messages, attempts: 1 });
  assert.equal(r2.fire, false);
}

// create_subagent FAILED → fire
{
  const messages = [
    { role: 'user', content: 'spawn a fix' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'create_subagent', input: { task: 'fix x' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          name: 'create_subagent',
          content: '[Sub-agent ab12] FAILED\n(no output)\n(empty output treated as failure)',
          is_error: true,
        },
      ],
    },
  ];
  const r = evaluateFanOutNudge({ messages, attempts: 0 });
  assert.equal(r.fire, true);
}

console.log('[PASS] fan-out-nudge');
