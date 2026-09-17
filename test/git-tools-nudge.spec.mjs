#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateGitToolsNudge } from '../dist/core/loop/git-tools-nudge.js';
import { collectExecCommands } from '../dist/core/loop/nudge-helpers.js';

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
  assert.deepEqual(collectExecCommands(messages), ['git commit -m "fix"']);
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

// Tag/release/issue asks fire when tools ran without git/gh
{
  const r = evaluateGitToolsNudge({
    userText: 'create a release and tag v1.0.0',
    toolCallsByName: { edit_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /tag|release|issue|git|gh/i);
}

{
  const r = evaluateGitToolsNudge({
    userText: 'file an issue for the follow-up',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
}

// gh release exec silences nudge
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'r1',
          name: 'exec',
          input: { command: 'gh release create v1.0.0' },
        },
      ],
    },
  ];
  const r = evaluateGitToolsNudge({
    userText: 'create a release',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// PR review/approve asks fire when tools ran without gh pr
{
  const r = evaluateGitToolsNudge({
    userText: 'please review the PR and approve the PR',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /review|approve|git|gh/i);
}

// gh pr review silences nudge
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'rv1',
          name: 'exec',
          input: { command: 'gh pr review --approve' },
        },
      ],
    },
  ];
  const r = evaluateGitToolsNudge({
    userText: 'approve the PR',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] git-tools-nudge');
