#!/usr/bin/env node
import assert from 'node:assert/strict';

import { activityLabel } from '../dist/cli/tui-utils.js';

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

console.log('cli-tui-noise.spec: low-noise labels passed');
