#!/usr/bin/env node
import assert from 'node:assert/strict';

import { activityLabel } from '../dist/cli/tui-utils.js';
import { legacyTheme as theme, applyTerminalThemeMode } from '../dist/cli/theme/theme.js';

applyTerminalThemeMode('light');
assert.equal(theme.text, '#0a0a0a', 'light terminal body text uses high-contrast ink');
assert.equal(theme.textMuted, '#4b5563', 'light terminal secondary text stays readable');

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

console.log('cli-tui-noise.spec: readable light theme and low-noise labels passed');
