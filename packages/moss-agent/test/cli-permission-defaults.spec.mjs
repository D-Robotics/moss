#!/usr/bin/env node
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { CLI_PROFILE_DEFAULTS } from '../dist/cli/config.js';
import {
  createCliToolApprovalHook,
  describeCliToolApproval,
  isAllowedDuringPlanMode,
  renderCliApprovalPrompt,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';
import { ApprovalPromptLine } from '../dist/cli/tui.js';

assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.approvalPolicy,
  'prompt',
  'balanced profile (the default) asks before sensitive actions — safe by default'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.safetyMode,
  'workspace-write',
  'balanced profile is workspace-scoped by default (full-access is autonomous)'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.autonomous.safetyMode,
  'full-access',
  'autonomous is the most permissive profile (full-access)'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.autonomous.approvalPolicy,
  'never',
  'autonomous auto-approves (explicit unrestricted execution)'
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

const preview = describeCliToolApproval(
  deviceMutation,
  'full-access',
  {},
  {
    approvalPolicy: 'never',
    boardMode: () => true,
  }
);
assert.equal(preview.requiresApproval, true, 'physical device mutation requires approval');
assert.equal(
  preview.autoApproved,
  true,
  'default approval policy auto-approves physical device mutations'
);

{
  const hook = createCliToolApprovalHook('full-access', {}, { approvalPolicy: 'never' });
  const decision = await hook({ ...deviceMutation, sessionKey: 'device-default-auto-allow' });
  assert.equal(
    decision.approved,
    true,
    'default full-access policy does not prompt for device mutations'
  );
}

const tool = (name, sideEffectClass) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass, planMode: 'requires_user_confirmation' },
  execute: async () => 'ok',
});

{
  let askerSawAbort = false;
  setCliApprovalAsker(async (_question, abortSignal) => {
    await new Promise((resolve) => {
      if (abortSignal?.aborted) {
        askerSawAbort = true;
        return resolve();
      }
      abortSignal?.addEventListener(
        'abort',
        () => {
          askerSawAbort = true;
          resolve();
        },
        { once: true }
      );
    });
    return '';
  });
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const controller = new AbortController();
  const decisionPromise = hook({
    tool: tool('write_file', 'local_write'),
    input: { path: 'notes.txt', content: 'safe' },
    sessionKey: 'abort-overlay',
    runId: 'run-abort-overlay',
    toolCallId: 'tool-abort-overlay',
    abortSignal: controller.signal,
  });
  controller.abort();
  await decisionPromise;
  assert.equal(
    askerSawAbort,
    true,
    'approval asker receives the run abort signal and can close its UI'
  );
  setCliApprovalAsker(null);
}

{
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const decision = await hook({
    tool: tool('write_file', 'local_write'),
    input: { path: 'notes.txt', content: 'safe' },
    sessionKey: 'headless-default',
  });
  assert.equal(
    decision.approved,
    false,
    'headless prompt policy denies mutations instead of silently approving'
  );
  assert.match(decision.reason, /non-interactive|approval/i);
}

{
  const hook = createCliToolApprovalHook(
    'workspace-write',
    {},
    {
      workspaceDir: process.cwd(),
      interactionMode: () => 'acceptEdits',
    }
  );
  const fileDecision = await hook({
    tool: tool('edit_file', 'local_write'),
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'accept-edits',
  });
  assert.equal(
    fileDecision.approved,
    true,
    'accept-edits may approve sandboxed workspace file edits'
  );
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
  assert.equal(
    execDecision.approved,
    false,
    'accept-edits does not silently approve arbitrary shell commands'
  );
}

{
  // Plan mode must honor metadata.planMode === 'allow' for planning helpers
  // (todo_write / ask_user_question / plan) while still blocking file mutations.
  const planHook = createCliToolApprovalHook(
    'workspace-write',
    {},
    {
      workspaceDir: process.cwd(),
      interactionMode: () => 'plan',
    }
  );
  const todoTool = {
    name: 'todo_write',
    description: 'todo',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
    execute: async () => 'ok',
  };
  const askTool = {
    name: 'ask_user_question',
    description: 'ask',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
    execute: async () => 'ok',
  };
  const editTool = tool('edit_file', 'local_write');
  const unsafeDeviceTool = {
    ...tool('unsafe_device_helper', 'device_mutation'),
    metadata: { sideEffectClass: 'device_mutation', planMode: 'allow' },
  };
  const unclassifiedExtensionTool = {
    name: 'deploy_artifact',
    description: 'custom extension with intentionally missing safety metadata',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'must not execute in Plan mode',
  };
  assert.equal(
    isAllowedDuringPlanMode(todoTool, 'runtime_state'),
    true,
    'planMode allow marks runtime_state planning tools as plan-safe'
  );
  assert.equal(
    isAllowedDuringPlanMode(editTool, 'local_write'),
    false,
    'mutating tools with requires_user_confirmation stay blocked in plan mode'
  );
  assert.equal(
    isAllowedDuringPlanMode(unsafeDeviceTool, 'device_mutation'),
    false,
    'device mutations stay blocked even if a tool accidentally declares planMode allow'
  );
  const unclassifiedPreview = describeCliToolApproval(
    { tool: unclassifiedExtensionTool, input: {} },
    'workspace-write',
    {},
    {}
  );
  assert.equal(
    unclassifiedPreview.sideEffect,
    'local_write',
    'missing safety metadata defaults to a reviewable mutation, never readonly'
  );
  assert.equal(unclassifiedPreview.requiresApproval, true);
  assert.equal(
    isAllowedDuringPlanMode(unclassifiedExtensionTool, unclassifiedPreview.sideEffect),
    false,
    'unclassified extensions fail closed in Plan mode'
  );
  assert.equal(
    (
      await planHook({
        tool: todoTool,
        input: { todos: [{ content: 'Explore entry points', status: 'in_progress' }] },
        sessionKey: 'plan-todo',
      })
    ).approved,
    true,
    'plan mode allows todo_write (planMode=allow)'
  );
  assert.equal(
    (
      await planHook({
        tool: askTool,
        input: { questions: [{ question: 'Which approach?' }] },
        sessionKey: 'plan-ask',
      })
    ).approved,
    true,
    'plan mode allows ask_user_question (planMode=allow)'
  );
  const blockedEdit = await planHook({
    tool: editTool,
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'plan-edit',
  });
  assert.equal(blockedEdit.approved, false, 'plan mode still blocks file mutations');
  assert.match(blockedEdit.reason ?? '', /Plan mode|Shift\+Tab|accept-edits/i);
  const blockedDevice = await planHook({
    tool: unsafeDeviceTool,
    input: { command: 'touch /tmp/must-not-run' },
    sessionKey: 'plan-unsafe-device',
  });
  assert.equal(
    blockedDevice.approved,
    false,
    'plan mode fails closed for the entire device_mutation class'
  );
  const blockedUnclassified = await planHook({
    tool: unclassifiedExtensionTool,
    input: {},
    sessionKey: 'plan-unclassified-extension',
  });
  assert.equal(
    blockedUnclassified.approved,
    false,
    'Plan mode rejects registered tools that omit safety metadata'
  );
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
  assert.equal(
    decision.approved,
    false,
    'workspace file tools reject path escape even in full access'
  );
  assert.equal(
    asked,
    false,
    'invalid path is rejected before showing a misleading approval prompt'
  );
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
  assert.equal(
    first.approved,
    true,
    'always can trust sandboxed file edits for this workspace session'
  );
  const command = await hook({
    tool: tool('exec', 'local_write'),
    input: { command: 'touch /tmp/moss-trust-escape' },
    sessionKey: 'workspace-trust',
  });
  assert.equal(
    command.approved,
    false,
    'workspace file trust never carries over to shell commands'
  );
  setCliApprovalAsker(null);
}

{
  const firstAnswers = ['a'];
  setCliApprovalAsker(async () => firstAnswers.shift() ?? '');
  const firstHook = createCliToolApprovalHook(
    'workspace-write',
    {},
    { workspaceDir: process.cwd() }
  );
  const request = {
    tool: tool('edit_file', 'local_write'),
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'trust-isolation-first',
  };
  assert.equal(
    (await firstHook(request)).approved,
    true,
    'first session accepts workspace edit trust'
  );

  let secondPrompted = false;
  setCliApprovalAsker(async () => {
    secondPrompted = true;
    return '';
  });
  const secondHook = createCliToolApprovalHook(
    'workspace-write',
    {},
    { workspaceDir: process.cwd() }
  );
  const secondDecision = await secondHook({ ...request, sessionKey: 'trust-isolation-second' });
  assert.equal(
    secondPrompted,
    true,
    'a fresh hook asks again instead of inheriting another session trust'
  );
  assert.equal(secondDecision.approved, false, 'session trust never becomes process-global trust');
  setCliApprovalAsker(null);
}

{
  const request = {
    tool: tool('write_file', 'local_write'),
    input: { path: 'approval-demo.txt', content: 'hello\n' },
    sessionKey: 'approval-card',
  };
  const cardPreview = describeCliToolApproval(
    request,
    'workspace-write',
    {},
    {
      approvalPolicy: 'prompt',
      workspaceDir: process.cwd(),
    }
  );
  const question = renderCliApprovalPrompt(cardPreview, request.input, {
    workspaceDir: process.cwd(),
  });
  const view = render(React.createElement(ApprovalPromptLine, { question }));
  const frame = view.lastFrame();
  view.unmount();
  assert.match(frame, /approval-demo\.txt/, 'workspace approval names the exact file');
  assert.match(frame, /\+ hello/, 'workspace approval previews the content change');
  assert.match(frame, /Trust workspace edits/, 'persistent option names only sandboxed file edits');
  assert.match(frame, /this Moss\s+session only/, 'persistent option is explicitly session-scoped');
}

{
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir: process.cwd(),
      approvalPolicy: 'never',
    }
  );
  const decision = await hook({
    tool: tool('exec', 'local_write'),
    input: { command: 'rm -rf -- /' },
    sessionKey: 'dangerous-command',
  });
  assert.equal(
    decision.approved,
    false,
    'destructive shell commands stay blocked even in full access'
  );
  assert.match(decision.reason, /blocked|filesystem|root|dangerous/i);
}

console.log(
  'cli-permission-defaults.spec: safe balanced default + explicit safety overrides passed'
);
