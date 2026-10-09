#!/usr/bin/env node
/**
 * Session titles, resume rows, and nudge matching skip internal phase prompts.
 */
import assert from 'node:assert/strict';

import {
  resumeUserText,
  selectNudgeUserText,
  sessionTitleFromTexts,
} from '../dist/core/session/internal-transcript.js';

const planning = [
  '[task-phase:planning]',
  'Complete it in order: plan, then implement, then verify.',
  'Goal: add a twenty-line helper',
  'Run npm test after the edit.',
].join('\n');

assert.equal(sessionTitleFromTexts([planning, '[System] keep going']), 'add a twenty-line helper');
assert.equal(sessionTitleFromTexts(['[System] only']), undefined);
assert.equal(sessionTitleFromTexts(['what is the board status?']), 'what is the board status?');

assert.equal(
  selectNudgeUserText([planning, '[System] npm test', 'what is the board status?']),
  'what is the board status?'
);
assert.equal(selectNudgeUserText([planning]), '');

assert.equal(resumeUserText(planning), 'add a twenty-line helper');
assert.equal(resumeUserText('[task-phase:executing]\nContinue the same goal.'), '');
assert.equal(resumeUserText('[System] Use this evidence to continue the task.'), '');
assert.equal(resumeUserText('what is the board status?'), 'what is the board status?');

console.log('[PASS] internal transcript');
