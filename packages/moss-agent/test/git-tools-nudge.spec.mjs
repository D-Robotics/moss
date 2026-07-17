#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateGitToolsNudge,
  collectExecCommandsFromMessages,
} from '../dist/core/loop/git-tools-nudge.js';

// No tools yet
{
  const r = evaluateGitToolsNudge({
    userText: 'commit and push the changes',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Commit ask + tools without git → fire
{
  const r = evaluateGitToolsNudge({
    userText: 'commit and push the changes',
    toolCallsByName: { edit_file: 1, run_tests: 1 },
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'edit_file', input: { path: 'a.ts' } }],
      },
    ],
    totalToolCalls: 2,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /git|gh pr/i);
}

// Git exec already present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'g1',
          name: 'exec',
          input: { command: 'git commit -m "fix"' },
        },
      ],
    },
  ];
  assert.deepEqual(collectExecCommandsFromMessages(messages), ['git commit -m "fix"']);
  const r = evaluateGitToolsNudge({
    userText: 'commit the fix',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateGitToolsNudge({
    userText: 'open a PR',
    toolCallsByName: { edit_file: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] git-tools-nudge');
