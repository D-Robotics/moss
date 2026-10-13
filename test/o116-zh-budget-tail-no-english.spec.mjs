#!/usr/bin/env node
/**
 * O116: zh budget-exceeded last line must not carry the English sentence
 * `Run budget exceeded …`; en line stays byte-identical. Spec: /workspace/specs/O116.md
 */
import assert from 'node:assert/strict';
import { createRunCompletionTracker, noteRunCompletionEvent } from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { formatProgressOutcomeLine } from '../dist/cli/run-progress.js';

const RUN_ERROR =
  'Run budget exceeded (tool_calls). Partial output above is the completed work; raise the budget or narrow the task to continue.';

function mk() {
  const t = createRunCompletionTracker();
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'r1',
    input: { path: 'src/a.ts' },
  });
  return t;
}

// A. --print text path (oneshot → resolveRunOutcome → formatOutcomeLine)
{
  const o = resolveRunOutcome({
    tracker: mk(),
    finalText: 'x',
    request: '修改 src/a.ts',
    runError: RUN_ERROR,
  });
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.doesNotMatch(zh, /Run budget exceeded/, `zh: no English sentence — ${zh}`);
  assert.doesNotMatch(zh, /Partial output above/, `zh: no English sentence — ${zh}`);
  assert.match(zh, /^未完成：运行预算用尽（tool_calls）/, `zh: Chinese main reason — ${zh}`);
  assert.match(zh, /卡在：运行预算（read_file/, `zh: O111 stuck half kept — ${zh}`);
  assert.ok(en.startsWith(`Incomplete: ${RUN_ERROR}`), `en unchanged — ${en}`);
  assert.equal(
    o.exitCode,
    resolveRunOutcome({ tracker: mk(), finalText: 'x', runError: RUN_ERROR }).exitCode
  );
  assert.notEqual(o.exitCode, 0);
}

// A'. key-less variant
{
  const o = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'x',
    runError: 'Run budget exceeded.',
  });
  assert.equal(formatOutcomeLine(o, 'zh'), '未完成：运行预算用尽；卡在：运行预算');
  assert.equal(
    formatOutcomeLine(o, 'en'),
    'Incomplete: Run budget exceeded.; stuck at: run budget'
  );
}

// TUI / progress path with the same English errorMessage
{
  const zh = formatProgressOutcomeLine({
    errorMessage: RUN_ERROR,
    stopReason: 'budget_tool_calls_reached',
    zh: true,
  });
  const en = formatProgressOutcomeLine({
    errorMessage: RUN_ERROR,
    stopReason: 'budget_tool_calls_reached',
    zh: false,
  });
  assert.doesNotMatch(zh, /Run budget exceeded|Partial output above/, `progress zh — ${zh}`);
  assert.match(zh, /运行预算用尽（tool_calls）/);
  assert.match(en, /Run budget exceeded \(tool_calls\)/);
}

// B. stuck half still aligned between stdout (English runError) and stderr (zh runError)
{
  const a = resolveRunOutcome({ tracker: mk(), finalText: 'x', runError: RUN_ERROR });
  const b = resolveRunOutcome({
    tracker: mk(),
    finalText: 'x',
    runError: '运行预算用尽，任务未完成',
  });
  assert.equal(a.stuckAtZh, b.stuckAtZh);
  assert.equal(a.stuckAt, b.stuckAt);
}

// Non-budget errors pass through unchanged in zh.
{
  const o = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'x',
    runError: 'boom',
  });
  assert.equal(formatOutcomeLine(o, 'zh'), '未完成：boom');
}

console.log('o116 zh budget tail: ok');
