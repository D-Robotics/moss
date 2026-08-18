#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTaskCommand } from '../dist/cli/task-command.js';
import { ExecutionTaskController, InMemoryExecutionStore } from '../dist/orchestration/index.js';

test('task commands project the same graph ids, revisions, and recovery actions', () => {
  const store = new InMemoryExecutionStore();
  store.create({ id: 'cli-task', goal: 'visible task', nodes: [] });
  const agent = { tasks: new ExecutionTaskController(store), executionStore: store };
  assert.match(handleTaskCommand(agent, '/tasks'), /cli-task\s+paused\s+rev=1/);
  assert.match(handleTaskCommand(agent, '/task inspect cli-task'), /visible task/);
  assert.match(handleTaskCommand(agent, '/task resume cli-task'), /running\s+rev=2/);
  assert.match(handleTaskCommand(agent, '/task stop cli-task'), /cancelled\s+rev=3/);
  assert.match(handleTaskCommand(agent, '/task inspect missing'), /^Error: unknown task/);
});
