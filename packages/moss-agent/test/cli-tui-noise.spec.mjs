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
  'internal checkpoint status never leaks into the transcript',
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

  const rendered = render(React.createElement(ActivityItemLine, {
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
  }));
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /web_search.*suppressed/);
  assert.doesNotMatch(frame, /blocked|Tool loop guard|!/, 'suppression is neutral, not an error block');
}

{
  const rendered = render(React.createElement(ActivityItemLine, {
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
  }));
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /cancelled/i, 'user-cancelled tools are visible as a neutral outcome');
  assert.doesNotMatch(frame, /Execution error|!/, 'user cancellation is not rendered as a red execution failure');
}

{
  const rendered = render(React.createElement(ActivityItemLine, {
    item: {
      id: 'blocked-read',
      toolName: 'read_file',
      toolCallId: 'blocked-read',
      startedAt: 0,
      status: 'failed',
      inputSummary: '/tmp/outside-workspace',
      elapsedMs: 2,
      outcome: 'blocked',
      result: 'Operation blocked by workspace policy. The tool did not inspect the target, so its existence is unknown. Path escapes workspace: /tmp/outside-workspace',
    },
  }));
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /blocked/i, 'policy blocks are distinguished from execution failures');
  assert.doesNotMatch(frame, /Execution error|Path escapes workspace|!/, 'collapsed policy blocks hide technical noise');
  assert.equal(frame.trim().split('\n').length, 1, 'collapsed policy blocks stay on one readable line');
}

{
  const rendered = render(React.createElement(TranscriptMessage, {
    item: {
      id: 1,
      kind: 'assistant',
      text: '今天的机器人新闻摘要。',
      finalized: true,
    },
  }));
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.match(frame, /今天的机器人新闻摘要/);
}

{
  const rendered = render(React.createElement(TranscriptMessage, {
    item: {
      id: 4,
      kind: 'system',
      text: 'Status\n  model: test\n  workspace: /tmp/project',
      finalized: true,
    },
  }));
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.equal((frame.match(/·/g) ?? []).length, 1, 'a multi-line system block has one marker, not one marker per wrapped line');
  assert.match(frame, /· Status\n\s+model: test/, 'continuation lines remain visually grouped under the first line');
}

{
  const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuv'].join('-');
  const rendered = render(React.createElement(TranscriptMessage, {
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
  }));
  const frame = rendered.lastFrame();
  rendered.unmount();
  assert.ok(!frame.includes(secret), 'TUI never renders raw secrets from tool input or output');
  assert.match(frame, /\*\*\*/, 'TUI shows a visible redaction marker');
}

console.log('cli-tui-noise.spec: readable light theme and low-noise tool states passed');

{
  const view = render(React.createElement(StatusBar, {
    state: 'idle',
    device: 'host',
    workspace: '/tmp/moss',
    version: 'v0.5.3',
    model: 'test-model',
    ctxUsage: { used: 1000, total: 100000, source: 'provider' },
  }));
  const frame = view.lastFrame();
  view.unmount();
  assert.ok(frame.includes('ctx 1k/100k (1%)'), 'status bar keeps context usage compact');
  assert.ok(!frame.includes('· provider'), 'provider provenance stays in /context, not the crowded footer');
}

{
  const rendered = render(React.createElement(ActivityItemLine, {
    item: {
      id: 'running-exec',
      toolName: 'exec',
      toolCallId: 'running-exec',
      startedAt: Date.now() - 2500,
      status: 'running',
      inputSummary: 'npm test',
    },
  }));
  const frame = rendered.lastFrame() || '';
  rendered.unmount();
  assert.match(frame, /exec/, 'running tool shows name');
  assert.match(frame, /2s…|2s\.\.\.|…/, 'running tool shows live elapsed clock (Grok-style)');
}
