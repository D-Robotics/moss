#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRunCompletionTracker,
  noteRunCompletionEvent,
  requestExpectsFileChanges,
} from '../dist/cli/run-completion.js';
import { resolveRunOutcome } from '../dist/cli/run-outcome.js';

test('read-only requests with explicit no-edit constraints finish normally', () => {
  const requests = [
    '请读取当前目录的 README.md，并用一句中文概括，不要修改文件。',
    '请检查配置，不要修改或删除任何文件。',
    'Read README.md and summarize it; do not edit any files.',
    "Inspect the project. Don't change the source files.",
  ];
  for (const request of requests) {
    const tracker = createRunCompletionTracker();
    noteRunCompletionEvent(tracker, {
      type: 'tool_start',
      toolName: 'read_file',
      toolCallId: 'read',
      input: { path: 'README.md' },
    });
    noteRunCompletionEvent(tracker, {
      type: 'tool_end',
      toolName: 'read_file',
      toolCallId: 'read',
      result: 'A sample workspace.',
      isError: false,
    });
    assert.equal(requestExpectsFileChanges(request), false, request);
    const outcome = resolveRunOutcome({ tracker, request, finalText: 'A sample workspace.' });
    assert.equal(outcome.status, 'completed', request);
    assert.equal(outcome.exitCode, 0, request);
  }
});

test('positive edit requests still require changes despite separate negative constraints', () => {
  const requests = [
    '修复解析器，但不要修改 README。',
    '不要新增依赖，而是修复现有代码。',
    'Fix the parser, but do not change README.md.',
    'Do not add dependencies; fix the bug in src/parser.ts.',
  ];
  for (const request of requests) {
    assert.equal(requestExpectsFileChanges(request), true, request);
    const outcome = resolveRunOutcome({
      tracker: createRunCompletionTracker(),
      request,
      finalText: 'Done.',
    });
    assert.equal(outcome.status, 'incomplete', request);
    assert.notEqual(outcome.exitCode, 0, request);
  }
});
