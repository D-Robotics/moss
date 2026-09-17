#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateTodoNudge,
  TODO_NUDGE_MIN_TOOLS,
  TODO_NUDGE_MIN_TURNS,
} from '../dist/core/loop/todo-nudge.js';

// Not enough turns/tools
{
  const r = evaluateTodoNudge({
    turns: 1,
    totalToolCalls: 1,
    toolCallsByName: { read_file: 1 },
    userText: 'fix the login bug and add tests',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Already used todo_write
{
  const r = evaluateTodoNudge({
    turns: 5,
    totalToolCalls: 8,
    toolCallsByName: { todo_write: 1, edit_file: 2 },
    userText: 'fix the login bug and add tests',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Already nudged once
{
  const r = evaluateTodoNudge({
    turns: 5,
    totalToolCalls: 8,
    toolCallsByName: { read_file: 3, edit_file: 2 },
    userText: 'fix the login bug and add tests',
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

// Multi-step coding past thresholds → fire
{
  const r = evaluateTodoNudge({
    turns: TODO_NUDGE_MIN_TURNS,
    totalToolCalls: TODO_NUDGE_MIN_TOOLS,
    toolCallsByName: { read_file: 2, search_code: 1 },
    userText: 'fix the pre-abort child process bug and add a regression test',
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /todo_write/);
  assert.match(r.correction, /\[System\]/);
}

// Pure chat / trivial → no fire even with tools
{
  const r = evaluateTodoNudge({
    turns: 5,
    totalToolCalls: 5,
    toolCallsByName: { read_file: 5 },
    userText: 'hi',
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] todo-nudge');
