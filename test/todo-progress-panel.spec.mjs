#!/usr/bin/env node
/**
 * Sticky todo panel — parse todo_write results + TUI rendering + Ctrl+T.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { formatTodos, parseTodoChecklistText, todoWriteTool } from '../dist/tools/todo-tool.js';
import { TodoProgressPanel } from '../dist/cli/tui.js';
import { handleGlobalInput } from '../dist/cli/tui-input-handler.js';

// ── parse round-trip ─────────────────────────────────────────────────────────

{
  const text = formatTodos([
    { content: 'Locate auth entry', status: 'completed' },
    { content: 'Fix token refresh', status: 'in_progress' },
    { content: 'Add regression test', status: 'pending' },
  ]);
  const parsed = parseTodoChecklistText(text);
  assert.ok(parsed);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].status, 'completed');
  assert.equal(parsed[1].content, 'Fix token refresh');
  assert.equal(parsed[1].status, 'in_progress');
  assert.equal(parsed[2].status, 'pending');
}

{
  assert.deepEqual(parseTodoChecklistText('Todo list cleared.'), []);
  assert.equal(parseTodoChecklistText('random tool output'), null);
  assert.equal(parseTodoChecklistText(''), null);
}

{
  const out = await todoWriteTool.execute(
    {
      todos: [
        { content: 'Read loop scheduler', status: 'completed' },
        { content: 'Patch stream path', status: 'in_progress' },
      ],
    },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'test',
      abortSignal: new AbortController().signal,
    }
  );
  const parsed = parseTodoChecklistText(out);
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].status, 'in_progress');
}

// ── TUI panel render ─────────────────────────────────────────────────────────

{
  const todos = [
    { content: 'Locate auth entry', status: 'completed' },
    { content: 'Fix token refresh', status: 'in_progress' },
    { content: 'Add regression test', status: 'pending' },
  ];
  const view = render(React.createElement(TodoProgressPanel, { todos, collapsed: false }));
  const frame = view.lastFrame() || '';
  view.unmount();
  assert.match(frame, /Tasks|任务进度/);
  assert.match(frame, /1\/3|1\/3 complete/);
  assert.ok(frame.includes('Fix token refresh'), 'shows active item');
  assert.ok(frame.includes('Locate auth entry'), 'shows completed item');
  assert.ok(frame.includes('Add regression test'), 'shows pending item');
}

{
  const todos = [
    { content: 'Locate auth entry', status: 'completed' },
    { content: 'Fix token refresh', status: 'in_progress' },
  ];
  const view = render(React.createElement(TodoProgressPanel, { todos, collapsed: true }));
  const frame = view.lastFrame() || '';
  view.unmount();
  assert.match(frame, /1\/2/);
  assert.ok(frame.includes('Fix token refresh'), 'collapsed still shows focus');
  assert.ok(!frame.includes('Locate auth entry'), 'collapsed hides full list');
}

{
  const view = render(React.createElement(TodoProgressPanel, { todos: [] }));
  const emptyFrame = view.lastFrame();
  view.unmount();
  assert.ok(emptyFrame == null || emptyFrame.trim() === '', 'empty todos render nothing');
}

// ── Ctrl+T toggles collapse ──────────────────────────────────────────────────

{
  const calls = { setTodosCollapsed: [], showFlash: [] };
  let collapsed = false;
  const deps = {
    sessionPicker: null,
    setSessionPicker: () => {},
    modelPicker: null,
    setModelPicker: () => {},
    approval: null,
    setApproval: () => {},
    input: '',
    setInput: () => {},
    setInputCursor: () => {},
    pendingAttachments: [],
    setPendingAttachments: () => {},
    setPendingAttachmentBlocks: () => {},
    suppressedAutoAttachInputRef: { current: null },
    activeRunControllerRef: { current: null },
    showFlash: (msg) => calls.showFlash.push(msg),
    requestStop: () => {},
    addTranscript: () => {},
    switchModelForSession: () => {},
    resumeSession: () => {},
    setToolsExpanded: () => {},
    setTodosCollapsed: (updater) => {
      calls.setTodosCollapsed.push(updater);
      collapsed = typeof updater === 'function' ? updater(collapsed) : updater;
    },
    setInteractionMode: () => {},
    disconnectDeviceForSession: () => '',
    removeAttachmentRefsFromInput: (s) => s,
    clampPromptCursor: (_i, c) => c,
    agent: {},
  };
  const consumed = handleGlobalInput('t', { ctrl: true }, deps);
  assert.equal(consumed, true);
  assert.equal(collapsed, true);
  assert.equal(calls.showFlash[0], 'tasks collapsed');
  handleGlobalInput('t', { ctrl: true }, deps);
  assert.equal(collapsed, false);
  assert.equal(calls.showFlash[1], 'tasks expanded');
}

console.log('[PASS] todo progress panel');
