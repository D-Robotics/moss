#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createLoopTuiEventBridge,
  formatLoopStatusLine,
  resolveLoopMaxIterations,
} from '../dist/cli/loop-tui-events.js';

const calls = [];
const bridge = createLoopTuiEventBridge({
  addAssistant: () => { calls.push(['addAssistant']); return 7; },
  appendAssistant: (id, text) => calls.push(['appendAssistant', id, text]),
  finalizeAssistant: (id) => calls.push(['finalizeAssistant', id]),
  addTool: (event) => calls.push(['addTool', event.toolName]),
  finishTool: (event) => calls.push(['finishTool', event.toolCallId]),
  addError: (message) => calls.push(['addError', message]),
  addNotice: (message) => calls.push(['addNotice', message]),
  resetAssistant: (id) => calls.push(['resetAssistant', id]),
});

bridge({ type: 'text_delta', delta: 'Working' });
bridge({ type: 'tool_start', toolName: 'web_search', toolCallId: 't1', input: { query: 'agent cli' } });
bridge({ type: 'tool_end', toolName: 'web_search', toolCallId: 't1', isError: false, durationMs: 12, result: 'ok' });
bridge({ type: 'turn_end', turn: 1, usage: {} });

assert.deepEqual(calls, [
  ['addAssistant'],
  ['appendAssistant', 7, 'Working'],
  ['addTool', 'web_search'],
  ['finishTool', 't1'],
  ['finalizeAssistant', 7],
]);

console.log('[PASS] loop TUI events stream into visible transcript callbacks');

bridge({ type: 'retry', attempt: 2, error: 'temporary network timeout' });
assert.deepEqual(
  calls.slice(-1),
  [['addNotice', 'Retrying (attempt 2): temporary network timeout']],
  'a recoverable retry is transient status, not a permanent error transcript',
);

assert.equal(
  formatLoopStatusLine({ iteration: 2, maxIterations: 20, elapsedSeconds: 9 }),
  'loop 2/20 · 9s · /loop stop after current step · /btw side question'
);
assert.equal(
  formatLoopStatusLine({ iteration: 2, maxIterations: 0, elapsedSeconds: 9 }),
  'loop 2/∞ · 9s · /loop stop after current step · /btw side question'
);
assert.equal(
  formatLoopStatusLine({ iteration: 2, maxIterations: 0, elapsedSeconds: 9, stopping: true }),
  'loop 2/∞ · 9s · stopping after current step…'
);
assert.equal(resolveLoopMaxIterations({}), 0, 'loop is unlimited by default');
assert.equal(resolveLoopMaxIterations({ MOSS_LOOP_MAX: '12' }), 12, 'explicit loop limit wins');
assert.equal(
  resolveLoopMaxIterations({ MOSS_LOOP_MAX: '12', MOSS_GOAL_AUTO_MAX_RUNS: '7' }, true),
  7,
  'goal-specific limit wins'
);
