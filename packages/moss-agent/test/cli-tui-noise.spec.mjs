#!/usr/bin/env node
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { ActivityItemLine, StatusBar, TranscriptMessage } from '../dist/cli/tui.js';
import { activityLabel } from '../dist/cli/tui-utils.js';
import { renderMarkdown } from '../dist/cli/tui-utils.js';
import { legacyTheme as theme, applyTerminalThemeMode } from '../dist/cli/theme/theme.js';

applyTerminalThemeMode('light');
assert.equal(theme.text, '#0a0a0a', 'light terminal body text uses high-contrast ink');
assert.equal(theme.textMuted, '#4b5563', 'light terminal secondary text stays readable');

{
  const heading = renderMarkdown('# 浅色终端标题');
  assert.doesNotMatch(heading, /\x1b\[97m/, 'markdown headings never force bright white text');
  assert.match(heading, /\x1b\[1m/, 'markdown headings retain bold hierarchy');
}

assert.equal(
  activityLabel({
    type: 'working_context_checkpoint',
    status: 'paused_resumable',
    reason: 'tool_loop_guard',
    goal: 'answer the user',
    nextAction: 'finish the answer',
  }),
  null,
  'internal checkpoint status never leaks into the transcript'
);

{
  const item = {
    id: 2,
    kind: 'tool',
    text: '',
    toolName: 'web_search',
    toolCallId: 't2',
    startedAt: 0,
    status: 'ok',
    toolInput: '机器人 新闻',
    elapsedMs: 0,
    outcome: 'suppressed',
    result: '[moss-agent] Tool loop guard stopped another web_search call',
  };
  const collapsed = render(React.createElement(TranscriptMessage, { item, toolsExpanded: false }));
  assert.equal(collapsed.lastFrame(), '', 'suppressed tools stay out of the default transcript');
  collapsed.unmount();

  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'suppressed-search',
        toolName: 'web_search',
        toolCallId: 't2',
        startedAt: 0,
        status: 'ok',
        inputSummary: '机器人 新闻',
        elapsedMs: 0,
        outcome: 'suppressed',
        result: '[moss-agent] Tool loop guard stopped another web_search call',
      },
    })
  );
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /web_search.*suppressed/);
  assert.doesNotMatch(
    frame,
    /blocked|Tool loop guard|!/,
    'suppression is neutral, not an error block'
  );
}

{
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'cancelled-fetch',
        toolName: 'web_fetch',
        toolCallId: 'cancelled-fetch',
        startedAt: 0,
        status: 'failed',
        inputSummary: 'https://example.com',
        elapsedMs: 358,
        result: 'Execution error: aborted_by_user: cancelled during execution',
      },
    })
  );
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /cancelled/i, 'user-cancelled tools are visible as a neutral outcome');
  assert.doesNotMatch(
    frame,
    /Execution error|!/,
    'user cancellation is not rendered as a red execution failure'
  );
}

{
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'blocked-read',
        toolName: 'read_file',
        toolCallId: 'blocked-read',
        startedAt: 0,
        status: 'failed',
        inputSummary: '/tmp/outside-workspace',
        elapsedMs: 2,
        outcome: 'blocked',
        result:
          'Operation blocked by workspace policy. The tool did not inspect the target, so its existence is unknown. Path escapes workspace: /tmp/outside-workspace',
      },
    })
  );
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /blocked/i, 'policy blocks are distinguished from execution failures');
  assert.doesNotMatch(
    frame,
    /Execution error|Path escapes workspace|!/,
    'collapsed policy blocks hide technical noise'
  );
  assert.equal(
    frame.trim().split('\n').length,
    1,
    'collapsed policy blocks stay on one readable line'
  );
}

{
  const rendered = render(
    React.createElement(TranscriptMessage, {
      item: {
        id: 1,
        kind: 'assistant',
        text: '今天的机器人新闻摘要。',
        finalized: true,
      },
    })
  );
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /今天的机器人新闻摘要/);
}

{
  const rendered = render(
    React.createElement(TranscriptMessage, {
      item: {
        id: 4,
        kind: 'system',
        text: 'Status\n  model: test\n  workspace: /tmp/project',
        finalized: true,
      },
    })
  );
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.equal(
    (frame.match(/·/g) ?? []).length,
    1,
    'a multi-line system block has one marker, not one marker per wrapped line'
  );
  assert.match(
    frame,
    /· Status\n\s+model: test/,
    'continuation lines remain visually grouped under the first line'
  );
}

{
  const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuv'].join('-');
  const rendered = render(
    React.createElement(TranscriptMessage, {
      item: {
        id: 3,
        kind: 'tool',
        text: '',
        toolName: 'exec',
        toolCallId: 'secret-tool',
        startedAt: 0,
        status: 'failed',
        toolInput: `curl -H "Authorization: Bearer ${secret}"`,
        toolInputRaw: { command: `echo ${secret}` },
        elapsedMs: 3,
        result: `request failed with token=${secret}`,
      },
      toolsExpanded: true,
    })
  );
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.ok(!frame.includes(secret), 'TUI never renders raw secrets from tool input or output');
  assert.match(frame, /\*\*\*/, 'TUI shows a visible redaction marker');
}

console.log('cli-tui-noise.spec: readable light theme and low-noise tool states passed');

{
  const view = render(
    React.createElement(StatusBar, {
      state: 'idle',
      device: 'host',
      workspace: '/tmp/moss',
      version: 'v0.5.3',
      model: 'test-model',
      ctxUsage: { used: 1000, total: 100000, source: 'provider' },
    })
  );
  const frame = view.lastFrame();
  view.unmount();
  assert.ok(frame.includes('ctx 1k/100k (1%)'), 'status bar keeps context usage compact');
  assert.ok(
    !frame.includes('· provider'),
    'provider provenance stays in /context, not the crowded footer'
  );
}

{
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'running-exec',
        toolName: 'exec',
        toolCallId: 'running-exec',
        startedAt: Date.now() - 2500,
        status: 'running',
        inputSummary: 'npm test',
      },
    })
  );
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /exec/, 'running tool shows name');
  assert.match(frame, /2s…|2s\.\.\.|…/, 'running tool shows live elapsed clock (Grok-style)');
}

// Successful code edits must show a colored diff preview without expanding (Ctrl+O).
{
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'edit-ok',
        toolName: 'edit_file',
        toolCallId: 'edit-ok',
        startedAt: Date.now() - 100,
        status: 'ok',
        elapsedMs: 80,
        inputSummary: 'auth.ts',
        inputSubline: 'Added 1 line',
        inputRaw: {
          path: 'src/auth.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;',
        },
        result: 'Edited src/auth.ts',
      },
    })
  );
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /edit_file/, 'edit tool name visible');
  assert.match(frame, /auth\.ts|src\/auth/, 'edit headline keeps path context');
  assert.match(
    frame,
    /const x = 1|const x = 2|- |\+ /,
    'collapsed edit shows code/diff content by default'
  );
}

{
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'write-ok',
        toolName: 'write_file',
        toolCallId: 'write-ok',
        startedAt: Date.now() - 100,
        status: 'ok',
        elapsedMs: 50,
        inputSummary: 'hello.ts',
        inputRaw: {
          path: 'src/hello.ts',
          content: 'export const hi = 1;\n',
        },
        result: 'Successfully wrote 20 chars',
      },
    })
  );
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /write_file/);
  assert.match(
    frame,
    /\+ export const hi|export const hi/,
    'collapsed write shows file content preview'
  );
}

// Failed run_tests must show failing case names without Ctrl+O (edit→verify UX).
{
  const rendered = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: 'tests-red',
        toolName: 'run_tests',
        toolCallId: 'tests-red',
        startedAt: Date.now() - 900,
        status: 'failed',
        elapsedMs: 880,
        inputSummary: '2 FAILED · 2 failed / 12',
        result:
          'Test Results: ❌ 2 FAILED\n' +
          'Command: npm test\n' +
          'Tests: 12 total, 10 passed, 2 failed, 0 skipped\n' +
          '\nFailures:\n' +
          '  • packages/moss-agent/test/todo-progress-panel.spec.mjs — Expected equal\n' +
          '  • packages/moss-agent/test/cli-onboarding.spec.mjs — missing /quickstart\n',
      },
      expanded: false,
    })
  );
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /run_tests/, 'failed suite shows tool name');
  assert.match(frame, /todo-progress-panel/, 'collapsed failed suite shows first failing test');
  assert.match(
    frame,
    /cli-onboarding|quickstart/,
    'collapsed failed suite shows second failing test'
  );
}
