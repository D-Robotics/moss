#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { parsePermissionRuleSpec } from '../dist/cli/permission-rules.js';
import { setCliApprovalViewAsker } from '../dist/cli/approval-view.js';

const deviceTool = {
  name: 'device_exec',
  description: 'Run a command on a device',
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass: 'device_mutation', planMode: 'requires_user_confirmation' },
  execute: async () => 'ok',
};

test('approving a reversible device call cannot grant all device commands', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-device-grant-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const previousConfig = process.env.MOSS_CONFIG_FILE;
  process.env.MOSS_CONFIG_FILE = path.join(workspaceDir, 'config.json');
  t.after(() => {
    if (previousConfig === undefined) delete process.env.MOSS_CONFIG_FILE;
    else process.env.MOSS_CONFIG_FILE = previousConfig;
  });

  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      persistTrust: true,
    }
  );
  const prompts = [];
  const answers = ['a', 'n'];
  const restore = hook.setAsker(async (prompt, _signal, dialog) => {
    prompts.push({ prompt, dialog });
    return answers.shift() ?? 'n';
  });
  t.after(restore);
  const call = (command) =>
    hook({ tool: deviceTool, input: { command }, sessionKey: 'device-test' });

  assert.equal((await call('systemctl restart robot')).approved, true);
  assert.equal((await call('reboot')).approved, false, 'reboot must ask separately');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].dialog.trustOptionAvailable, false);
  assert.doesNotMatch(prompts[0].prompt, /trusts workspace file-tool edits/);
  assert.doesNotMatch(prompts[0].prompt, /Blocked by workspace-write safety mode/i);
  const config = await fs.readFile(process.env.MOSS_CONFIG_FILE, 'utf8').catch(() => '');
  assert.doesNotMatch(config, /device_exec/, 'no blanket device rule is persisted');
});

test('an ask rule keeps the destructive device warning and continues to require approval', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-device-ask-rule-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      permissionRules: () => ({
        rules: [parsePermissionRuleSpec('device_exec', 'session', 'ask')],
        sources: {},
      }),
    }
  );
  const dialogs = [];
  const answers = ['a', 'n'];
  const restore = hook.setAsker(async (_prompt, _signal, dialog) => {
    dialogs.push(dialog);
    return answers.shift() ?? 'n';
  });
  t.after(restore);
  const call = () =>
    hook({ tool: deviceTool, input: { command: 'reboot' }, sessionKey: 'device-rule-test' });
  assert.equal((await call()).approved, true);
  assert.equal((await call()).approved, false, 'the ask rule remains effective');
  assert.equal(dialogs.length, 2);
  assert.match(dialogs[0].title, /destructive|毁灭性/i);
  assert.equal(dialogs[0].trustOptionAvailable, false, 'the ask rule must prompt every time');
});

test('the numbered No option is denied when a structured host returns its key', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-device-option-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
    }
  );
  const restoreAsker = hook.setAsker(async () => 'n');
  t.after(restoreAsker);
  const restoreView = setCliApprovalViewAsker(async (view) => {
    assert.equal(view.options.find((option) => option.key === '2').answer, 'n');
    return '2';
  });
  t.after(restoreView);
  const decision = await hook({
    tool: deviceTool,
    input: { command: 'systemctl restart robot' },
    sessionKey: 'numeric-device-answer',
  });
  assert.equal(decision.approved, false);
});
