#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { setCliInteractionMode } from '../dist/cli/interaction-mode.js';
import { parsePermissionRuleSpec, PermissionRuleRegistry } from '../dist/cli/permission-rules.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';

function request(workspaceDir) {
  return {
    tool: {
      name: 'write_file',
      description: 'Write a workspace file',
      inputSchema: { type: 'object', properties: {} },
      metadata: { sideEffectClass: 'local_write', planMode: 'requires_user_confirmation' },
      execute: async () => 'ok',
    },
    input: { path: path.join(workspaceDir, 'approval-probe.txt'), content: 'hello' },
    sessionKey: 'live-mode-test',
  };
}

test('live mode transitions override startup full defaults', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-mode-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  let currentMode = 'full';
  let prompts = 0;
  let lastPrompt = '';
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      approvalPolicy: 'never',
      workspaceDir,
      interactionMode: () => currentMode,
    }
  );
  const restore = hook.setAsker(async (prompt) => {
    prompts += 1;
    lastPrompt = prompt;
    return 'n';
  });
  t.after(restore);

  assert.equal((await hook(request(workspaceDir))).approved, true, 'full skips ordinary prompts');
  assert.equal(prompts, 0);
  currentMode = 'manual';
  assert.equal((await hook(request(workspaceDir))).approved, false, 'manual obeys user denial');
  assert.equal(prompts, 1, 'manual asks before writing');
  assert.doesNotMatch(lastPrompt, /auto-approved/i, 'the prompt must describe the live policy');
  currentMode = 'acceptEdits';
  assert.equal(
    (await hook(request(workspaceDir))).approved,
    true,
    'accept-edits allows file edits'
  );
  assert.equal(prompts, 1);
  currentMode = 'plan';
  assert.equal((await hook(request(workspaceDir))).approved, false, 'plan blocks writes');
  assert.equal(prompts, 1, 'plan blocks before asking');
  currentMode = 'full';
  assert.equal((await hook(request(workspaceDir))).approved, true, 'full can be selected again');
  assert.equal(prompts, 1);
});

test('live resolver takes precedence over startup auto-approval and restores the host mode', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-resolver-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const hook = createCliToolApprovalHook(
    'full-access',
    { MOSS_CLI_AUTO_APPROVE: '1', MOSS_AUTO_APPROVE: '1' },
    { workspaceDir, approvalPolicy: 'never', interactionMode: () => 'full' }
  );
  let prompts = 0;
  const restoreAsker = hook.setAsker(async () => {
    prompts += 1;
    return 'n';
  });
  t.after(restoreAsker);
  const restoreMode = hook.setInteractionModeResolver(() => 'manual');
  assert.equal((await hook(request(workspaceDir))).approved, false);
  assert.equal(prompts, 1, 'the active resolver requires confirmation');
  restoreMode();
  assert.equal((await hook(request(workspaceDir))).approved, true);
  assert.equal(prompts, 1, 'the original live mode is restored');
});

test('legacy hosts retain constructor and environment auto-approval', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-legacy-approval-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  setCliInteractionMode('manual');
  const fromConstructor = createCliToolApprovalHook('full-access', {}, { workspaceDir });
  const fromEnvironment = createCliToolApprovalHook(
    'workspace-write',
    { MOSS_AUTO_APPROVE: '1' },
    { workspaceDir }
  );
  assert.equal((await fromConstructor(request(workspaceDir))).approved, true);
  assert.equal((await fromEnvironment(request(workspaceDir))).approved, true);
});

test('deny rules and the read-only ceiling still override the live full mode', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-safety-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const denied = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'full',
      deniedTools: ['write_file'],
    }
  );
  const ceiling = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'full',
      readOnlyCeiling: true,
    }
  );
  assert.equal((await denied(request(workspaceDir))).approved, false);
  assert.equal((await ceiling(request(workspaceDir))).approved, false);
});

test('an explicit ask rule overrides session trust for workspace edits', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-ask-rule-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  let askEnabled = true;
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      permissionRules: () => ({
        rules: askEnabled ? [parsePermissionRuleSpec('write_file', 'session', 'ask')] : [],
        sources: {},
      }),
    }
  );
  let prompts = 0;
  const answers = ['a', 'n', 'n'];
  const restore = hook.setAsker(async () => {
    prompts += 1;
    return answers.shift() ?? 'n';
  });
  t.after(restore);
  assert.equal((await hook(request(workspaceDir))).approved, true);
  assert.equal((await hook(request(workspaceDir))).approved, false);
  askEnabled = false;
  assert.equal((await hook(request(workspaceDir))).approved, false);
  assert.equal(prompts, 3, 'an ask rule never creates a hidden future grant');
});

test('session approval grants appear in permissions and can be removed', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-rules-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const registry = new PermissionRuleRegistry();
  const rules = () => ({ rules: registry.list(), sources: {} });
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      permissionRules: rules,
      sessionPermissionRules: registry,
    }
  );
  const answers = ['a', 'n'];
  let prompts = 0;
  const restore = hook.setAsker(async () => {
    prompts += 1;
    return answers.shift() ?? 'n';
  });
  t.after(restore);
  assert.equal((await hook(request(workspaceDir))).approved, true);

  const said = [];
  const ctx = {
    agent: { config: { model: 'test' }, tools: { getAll: () => [], size: 0 } },
    runtime: { permissionRuleRegistry: registry, permissionsRules: rules },
    sessionKey: 'grant-registry',
    workspace: workspaceDir,
    locale: 'en',
    surface: 'repl',
    say: (_kind, text) => said.push(text),
    prefillInput: () => {},
  };
  await runRegistryCommand('/permissions', ctx);
  assert.match(said.join('\n'), /allow\s+write_file/);
  await runRegistryCommand('/permissions remove write_file', ctx);
  assert.equal((await hook(request(workspaceDir))).approved, false);
  assert.equal(prompts, 2, 'removing the rule causes the next call to ask');
});

test('workspace edit grants do not authorize another side effect using the same tool name', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-rule-scope-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const registry = new PermissionRuleRegistry();
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      sessionPermissionRules: registry,
    }
  );
  const answers = ['a', 'n'];
  const restore = hook.setAsker(async () => answers.shift() ?? 'n');
  t.after(restore);
  const fileRequest = request(workspaceDir);
  assert.equal((await hook(fileRequest)).approved, true);
  const otherRequest = {
    ...fileRequest,
    tool: { ...fileRequest.tool, metadata: { sideEffectClass: 'external_message' } },
  };
  assert.equal((await hook(otherRequest)).approved, false);
});

test('removing a session grant explains that a saved rule can survive restart', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-saved-rule-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const previousConfig = process.env.MOSS_CONFIG_FILE;
  process.env.MOSS_CONFIG_FILE = path.join(workspaceDir, 'config.json');
  t.after(() => {
    if (previousConfig === undefined) delete process.env.MOSS_CONFIG_FILE;
    else process.env.MOSS_CONFIG_FILE = previousConfig;
  });
  const registry = new PermissionRuleRegistry();
  const rules = () => ({ rules: registry.list(), sources: {} });
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      sessionPermissionRules: registry,
      persistTrust: true,
    }
  );
  const restore = hook.setAsker(async () => 'a');
  t.after(restore);
  assert.equal((await hook(request(workspaceDir))).approved, true);
  const saved = JSON.parse(await fs.readFile(process.env.MOSS_CONFIG_FILE, 'utf8'));
  assert.ok(saved.permissions.allow.includes('write_file'));
  const said = [];
  await runRegistryCommand('/permissions remove write_file', {
    agent: { config: { model: 'test' }, tools: { getAll: () => [], size: 0 } },
    runtime: { permissionRuleRegistry: registry, permissionsRules: rules },
    sessionKey: 'saved-grant',
    workspace: workspaceDir,
    locale: 'en',
    surface: 'repl',
    say: (_kind, text) => said.push(text),
    prefillInput: () => {},
  });
  assert.match(said.join('\n'), /saved.*remain|saved.*restart/i);
});

test('an ask rule never describes the pending request as auto-approved', async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-live-preview-'));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir,
      interactionMode: () => 'manual',
      trustedTools: ['write_file'],
      permissionRules: () => ({
        rules: [parsePermissionRuleSpec('write_file', 'session', 'ask')],
        sources: {},
      }),
    }
  );
  let prompt = '';
  const restore = hook.setAsker(async (question) => {
    prompt = question;
    return 'n';
  });
  t.after(restore);
  assert.equal((await hook(request(workspaceDir))).approved, false);
  assert.doesNotMatch(prompt, /auto-approv/i);
  assert.match(prompt, /ask rule/i);
});
