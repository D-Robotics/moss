#!/usr/bin/env node
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { CLI_PROFILE_DEFAULTS } from '../dist/cli/config.js';
import {
  createCliToolApprovalHook,
  describeCliToolApproval,
  renderCliApprovalPrompt,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';
import { ApprovalPromptLine } from '../dist/cli/tui.js';

assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.approvalPolicy,
  'prompt',
  'balanced profile asks before workspace changes; autonomous is the explicit auto-approve profile',
);

const deviceMutation = {
  tool: {
    name: 'ros2_topic_pub',
    description: 'Publish a command to a robot topic',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'device_mutation', planMode: 'requires_user_confirmation' },
    execute: async () => 'ok',
  },
  input: { topic: '/cmd_vel', message: { linear: { x: 1 } } },
};

const preview = describeCliToolApproval(deviceMutation, 'workspace-write', {}, {
  approvalPolicy: 'never',
  boardMode: () => true,
});
assert.equal(preview.requiresApproval, true, 'physical device mutation requires approval');
assert.equal(preview.boardAutoApproved, false, 'board connection never auto-approves physical mutation');
assert.equal(preview.autoApproved, false, 'approvalPolicy=never cannot bypass physical mutation confirmation');

{
  const question = renderCliApprovalPrompt(preview, deviceMutation.input, {});
  const view = render(React.createElement(ApprovalPromptLine, { question }));
  const frame = view.lastFrame();
  view.unmount();
  assert.match(frame, /connected device/i, 'device approval names the physical scope');
  assert.match(frame, /approve once/i, 'device approval offers one-time confirmation');
  assert.doesNotMatch(frame, /Always this scope|Trust workspace edits/i, 'device approval never renders persistent trust');
}

const tool = (name, sideEffectClass) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass, planMode: 'requires_user_confirmation' },
  execute: async () => 'ok',
});

{
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const decision = await hook({
    tool: tool('write_file', 'local_write'),
    input: { path: 'notes.txt', content: 'safe' },
    sessionKey: 'headless-default',
  });
  assert.equal(decision.approved, false, 'headless prompt policy denies mutations instead of silently approving');
  assert.match(decision.reason, /non-interactive|approval/i);
}

{
  const hook = createCliToolApprovalHook('workspace-write', {}, {
    workspaceDir: process.cwd(),
    interactionMode: () => 'acceptEdits',
  });
  const fileDecision = await hook({
    tool: tool('edit_file', 'local_write'),
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'accept-edits',
  });
  assert.equal(fileDecision.approved, true, 'accept-edits may approve sandboxed workspace file edits');
  const messageDecision = await hook({
    tool: tool('send_message', 'external_message'),
    input: { channel: 'public', text: 'ship it' },
    sessionKey: 'accept-edits',
  });
  assert.equal(messageDecision.approved, false, 'accept-edits never expands to external messages');
  const execDecision = await hook({
    tool: tool('exec', 'local_write'),
    input: { command: 'npm install surprise-package' },
    sessionKey: 'accept-edits',
  });
  assert.equal(execDecision.approved, false, 'accept-edits does not silently approve arbitrary shell commands');
}

{
  let asked = false;
  setCliApprovalAsker(async () => {
    asked = true;
    return 'y';
  });
  const hook = createCliToolApprovalHook('full-access', {}, { workspaceDir: process.cwd() });
  const decision = await hook({
    tool: tool('write_file', 'local_write'),
    input: { path: '../outside.txt', content: 'escape' },
    sessionKey: 'workspace-escape',
  });
  assert.equal(decision.approved, false, 'workspace file tools reject path escape even in full access');
  assert.equal(asked, false, 'invalid path is rejected before showing a misleading approval prompt');
  assert.match(decision.reason, /outside|escape|sandbox/i);
  setCliApprovalAsker(null);
}

{
  const answers = ['a', ''];
  setCliApprovalAsker(async () => answers.shift() ?? '');
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const first = await hook({
    tool: tool('edit_file', 'local_write'),
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'workspace-trust',
  });
  assert.equal(first.approved, true, 'always can trust sandboxed file edits for this workspace session');
  const command = await hook({
    tool: tool('exec', 'local_write'),
    input: { command: 'touch /tmp/moss-trust-escape' },
    sessionKey: 'workspace-trust',
  });
  assert.equal(command.approved, false, 'workspace file trust never carries over to shell commands');
  setCliApprovalAsker(null);
}

{
  const firstAnswers = ['a'];
  setCliApprovalAsker(async () => firstAnswers.shift() ?? '');
  const firstHook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const request = {
    tool: tool('edit_file', 'local_write'),
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'trust-isolation-first',
  };
  assert.equal((await firstHook(request)).approved, true, 'first session accepts workspace edit trust');

  let secondPrompted = false;
  setCliApprovalAsker(async () => {
    secondPrompted = true;
    return '';
  });
  const secondHook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const secondDecision = await secondHook({ ...request, sessionKey: 'trust-isolation-second' });
  assert.equal(secondPrompted, true, 'a fresh hook asks again instead of inheriting another session trust');
  assert.equal(secondDecision.approved, false, 'session trust never becomes process-global trust');
  setCliApprovalAsker(null);
}

{
  const request = {
    tool: tool('write_file', 'local_write'),
    input: { path: 'approval-demo.txt', content: 'hello\n' },
    sessionKey: 'approval-card',
  };
  const cardPreview = describeCliToolApproval(request, 'workspace-write', {}, {
    approvalPolicy: 'prompt',
    workspaceDir: process.cwd(),
  });
  const question = renderCliApprovalPrompt(cardPreview, request.input, { workspaceDir: process.cwd() });
  const view = render(React.createElement(ApprovalPromptLine, { question }));
  const frame = view.lastFrame();
  view.unmount();
  assert.match(frame, /approval-demo\.txt/, 'workspace approval names the exact file');
  assert.match(frame, /\+ hello/, 'workspace approval previews the content change');
  assert.match(frame, /Trust workspace edits/, 'persistent option names only sandboxed file edits');
  assert.match(frame, /this Moss\s+session only/, 'persistent option is explicitly session-scoped');
}

{
  const hook = createCliToolApprovalHook('full-access', {}, {
    workspaceDir: process.cwd(),
    approvalPolicy: 'never',
  });
  const decision = await hook({
    tool: tool('exec', 'local_write'),
    input: { command: 'rm -rf -- /' },
    sessionKey: 'dangerous-command',
  });
  assert.equal(decision.approved, false, 'destructive shell commands stay blocked even in full access');
  assert.match(decision.reason, /blocked|filesystem|root|dangerous/i);
}

console.log('cli-permission-defaults.spec: safe balanced defaults and physical confirmation passed');
