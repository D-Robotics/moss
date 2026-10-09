#!/usr/bin/env node
/**
 * The TTY gate applies only to the process-wide fallback asker. A host-provided
 * askUserQuestion is the UI the user can see and must run even when stdin is
 * not a TTY. The TTY bit is injected on the tool context.
 */
import assert from 'node:assert/strict';

import { askUserQuestionTool } from '../dist/tools/ask-user-question.js';
import {
  getUserQuestionAsker,
  setUserQuestionAsker,
} from '../dist/core/tools/user-question-asker.js';

const question = {
  questions: [{ question: 'Which path?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
};

const previous = getUserQuestionAsker();
try {
  let fallbackCalls = 0;
  setUserQuestionAsker(async () => {
    fallbackCalls += 1;
    return '2';
  });

  let hostCalls = 0;
  const hosted = await askUserQuestionTool.execute(question, {
    workspaceDir: '/tmp',
    sessionKey: 'ask-user',
    stdinIsTTY: false,
    askUserQuestion: async () => {
      hostCalls += 1;
      return '1';
    },
  });
  assert.equal(hostCalls, 1, 'a host asker runs when stdin is not a TTY');
  assert.equal(fallbackCalls, 0, 'the fallback asker is not used when the host provided one');
  assert.match(hosted, /alpha/);

  const hidden = await askUserQuestionTool.execute(question, {
    workspaceDir: '/tmp',
    sessionKey: 'ask-user',
    stdinIsTTY: false,
  });
  assert.equal(fallbackCalls, 0, 'a hidden fallback asker is not invoked');
  assert.match(hidden, /non-interactive/);
  assert.match(hidden, /best judgment/);

  const visible = await askUserQuestionTool.execute(question, {
    workspaceDir: '/tmp',
    sessionKey: 'ask-user',
    stdinIsTTY: true,
  });
  assert.equal(fallbackCalls, 1, 'a visible fallback asker is invoked');
  assert.match(visible, /beta/);
} finally {
  setUserQuestionAsker(previous);
}

console.log('[PASS] ask user question');
