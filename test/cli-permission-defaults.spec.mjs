#!/usr/bin/env node
/**
 * v0.26 permission defaults (T01 rewrite).
 *
 * Behavior decisions from PRD 2026-10-08
 * (docs/superpowers/plans/2026-10-08-v026-permission-model.md):
 * - W1 default flip: out-of-box mode is `full` (full-access + never +
 *   device_mutation allow). The old balanced=workspace-write+prompt assertions
 *   were rewritten as MIGRATION assertions: a legacy `profile: balanced` key
 *   reads in and migrates to `manual`.
 * - Hard blocks survive the flip untouched: dangerous commands, path escapes,
 *   deniedTools.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLI_PROFILE_DEFAULTS,
  migrateLegacyPermissionConfig,
  resolveCliConfig,
} from '../dist/cli/config.js';
import { deriveEngineQuantas } from '../dist/cli/interaction-mode.js';
import { parsePermissionRuleSpec } from '../dist/cli/permission-rules.js';
import {
  createCliToolApprovalHook,
  describeCliToolApproval,
  isAllowedDuringPlanMode,
  renderCliApprovalPrompt,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';

// ─── 1. migration semantics: legacy profile keys (PRD migration table) ─────

{
  const migrated = migrateLegacyPermissionConfig({ profile: 'balanced' });
  assert.equal(
    migrated.defaultMode,
    'manual',
    'legacy profile: balanced key reads in and migrates to manual (PRD 2026-10-08 迁移表)'
  );
  assert.equal(
    migrateLegacyPermissionConfig({ profile: 'cautious' }).defaultMode,
    'manual',
    'legacy profile: cautious migrates to manual'
  );
  assert.equal(
    migrateLegacyPermissionConfig({ profile: 'cautious' }).ceiling,
    'read-only',
    'legacy cautious arms the read-only ceiling'
  );
  assert.equal(
    migrateLegacyPermissionConfig({ profile: 'autonomous' }).defaultMode,
    'full',
    'legacy profile: autonomous migrates to full'
  );
}

// ─── 2. new default: no config at all → full (PRD W1 default flip) ──────────

{
  const resolved = resolveCliConfig({ MOSS_NO_BUNDLED_DEFAULT: '1' }, {});
  assert.equal(
    resolved.permissions.defaultMode,
    'full',
    'v0.26 default: no permission config → defaultMode=full (PRD 2026-10-08 W1 默认翻转)'
  );
  assert.equal(resolved.safetyMode, 'full-access', 'derived safetyMode=full-access');
  assert.equal(resolved.approvalPolicy, 'never', 'derived approvalPolicy=never');
}

// ─── 3. CLI_PROFILE_DEFAULTS: balanced tier is full-equivalent (fields kept) ─

assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.safetyMode,
  'full-access',
  'balanced tier defaults to full-access equivalent — v0.26 默认翻转 (PRD 2026-10-08); field names kept for SDK compat, semantics owned by permissions.defaultMode'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.approvalPolicy,
  'never',
  'balanced tier approvalPolicy=never (full equivalent)'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.autonomous.safetyMode,
  'full-access',
  'autonomous stays full-access'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.autonomous.approvalPolicy,
  'never',
  'autonomous auto-approves (explicit unrestricted execution)'
);

// ─── 4. device_mutation is allowed in full mode (PRD 量化表) ────────────────

assert.equal(
  deriveEngineQuantas('full').deviceMutationPolicy,
  'allow',
  'full mode derives deviceMutationPolicy=allow (PRD 量化表: device_mutation 默认（full 模式）→ 放行)'
);
assert.equal(
  deriveEngineQuantas('manual').deviceMutationPolicy,
  'ask',
  'manual mode keeps device_mutation at ask (逐次审批)'
);
assert.equal(
  deriveEngineQuantas('plan').deviceMutationPolicy,
  'deny',
  'plan mode keeps the device_mutation class-level deny'
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

// The full-mode preview: physical device mutation auto-approves (v0.26
// default full == old full-access + never, behavior unchanged for this path).
const preview = describeCliToolApproval(
  deviceMutation,
  'full-access',
  {},
  {
    approvalPolicy: 'never',
    boardMode: () => true,
  }
);
assert.equal(preview.requiresApproval, true, 'physical device mutation requires approval metadata');
assert.equal(
  preview.autoApproved,
  true,
  'full mode auto-approves physical device mutations (deviceMutationPolicy=allow)'
);

{
  const hook = createCliToolApprovalHook('full-access', {}, { approvalPolicy: 'never' });
  const decision = await hook({ ...deviceMutation, sessionKey: 'device-default-auto-allow' });
  assert.equal(
    decision.approved,
    true,
    'full mode (v0.26 default) does not prompt for device mutations'
  );
}

const tool = (name, sideEffectClass) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass, planMode: 'requires_user_confirmation' },
  execute: async () => 'ok',
});

// ─── 5. hard blocks survive the default flip (PRD 硬底线保留) ───────────────

{
  // Dangerous commands still blocked in full access.
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

{
  // Path escape still blocked in full access.
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
  // deniedTools still block in full access (deny > mode).
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    { workspaceDir: process.cwd(), approvalPolicy: 'never', deniedTools: ['exec'] }
  );
  const decision = await hook({
    tool: tool('exec', 'local_write'),
    input: { command: 'echo hi' },
    sessionKey: 'denied-tools-block',
  });
  assert.equal(
    decision.approved,
    false,
    'deniedTools still block in full access (deny wins over any mode — PRD 硬底线)'
  );
  assert.match(decision.reason, /deny rule/i, 'v0.26: deniedTools translate to deny rules (T03)');
}

// ─── 6. abort-signal propagation to the asker (unchanged behavior) ─────────

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

// ─── 7. manual-mode behavior preserved (headless denial etc.) ───────────────

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

// ─── 8. plan-mode class-level guards (unchanged semantics) ──────────────────

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
  const misleadingUnclassifiedTools = ['get_and_delete', 'search_and_send'].map((name) => ({
    ...unclassifiedExtensionTool,
    name,
  }));
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
  for (const misleadingTool of misleadingUnclassifiedTools) {
    const preview = describeCliToolApproval(
      { tool: misleadingTool, input: {} },
      'workspace-write',
      {},
      {}
    );
    assert.equal(
      preview.sideEffect,
      'local_write',
      `${misleadingTool.name} must not become readonly based on its name`
    );
    assert.equal(preview.requiresApproval, true);
    assert.equal(isAllowedDuringPlanMode(misleadingTool, preview.sideEffect), false);
  }
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
  for (const misleadingTool of misleadingUnclassifiedTools) {
    const decision = await planHook({
      tool: misleadingTool,
      input: {},
      sessionKey: `plan-${misleadingTool.name}`,
    });
    assert.equal(
      decision.approved,
      false,
      `Plan mode rejects missing metadata even when ${misleadingTool.name} starts with a read verb`
    );
  }
}

// ─── 9. headless guidance names real knobs ──────────────────────────────────

{
  // A headless run that hits the approval wall must name the exact knobs —
  // "use an explicit policy" without the flag/command is a dead end for a
  // first-time one-shot user.
  const wasTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  setCliApprovalAsker(null);
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const decision = await hook({
    tool: tool('edit_file', 'local_write'),
    input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
    sessionKey: 'headless-guidance',
  });
  Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  assert.equal(decision.approved, false, 'headless stays denied without a policy');
  // v0.26 (T03, PRD W3): the headless rejection names the NEW mode knobs —
  // /mode full, --full-access, permissions.defaultMode — not the old
  // --accept-edits/profile=autonomous/MOSS_CLI_AUTO_APPROVE trio.
  assert.match(decision.reason, /\/mode full/, 'the rejection names /mode full');
  assert.match(decision.reason, /--full-access/, 'the rejection names --full-access');
  assert.match(
    decision.reason,
    /permissions.defaultMode=full/,
    'the rejection names the persistent permissions.defaultMode key'
  );
  assert.match(
    decision.reason,
    /\/permissions/,
    'the rejection points at /permissions allow rules'
  );
}

// ─── 10. 'a' trust semantics (unchanged in T01; T03 moves to rules) ─────────

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

// ─── 11. approval card content (unchanged) ──────────────────────────────────

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
  assert.match(question, /approval-demo\.txt/, 'workspace approval names the exact file');
  assert.match(question, /\+ hello/, 'workspace approval previews the content change');
  assert.match(
    question,
    /\[a\]lways trusts sandboxed workspace file edits/,
    'persistent option names only sandboxed file edits'
  );
  assert.match(
    question,
    /this Moss session only/,
    'persistent option is explicitly session-scoped'
  );
}

// ─── 12. 'a' on exec: session trust, and (opt-in) persisted grants ──────────

const execRequest = (command) => ({
  tool: {
    name: 'exec',
    description: 'Run a shell command',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'local_write', planMode: 'requires_user_confirmation' },
    execute: async () => 'ok',
  },
  input: { command },
});

{
  const answers = ['a'];
  setCliApprovalAsker(async () => answers.shift() ?? '');
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: process.cwd() });
  const first = await hook({
    ...execRequest('touch /tmp/moss-a-trust-1'),
    sessionKey: 'exec-trust',
  });
  assert.equal(first.approved, true, "'a' approves the command");
  let secondPrompted = false;
  setCliApprovalAsker(async () => {
    secondPrompted = true;
    return '';
  });
  const second = await hook({
    ...execRequest('touch /tmp/moss-a-trust-2'),
    sessionKey: 'exec-trust',
  });
  assert.equal(secondPrompted, false, "'a' on exec stops asking for the rest of the session");
  assert.equal(second.approved, true, 'the second command runs without a prompt');
  setCliApprovalAsker(null);
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-trust-persist-'));
  const prevConfigDir = process.env.MOSS_CONFIG_DIR;
  process.env.MOSS_CONFIG_DIR = configDir;
  try {
    // Without persistTrust (the scripted/test default): 'a' must not write.
    const answers = ['a'];
    setCliApprovalAsker(async () => answers.shift() ?? '');
    const bareHook = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
      }
    );
    await bareHook({ ...execRequest('touch /tmp/moss-p0'), sessionKey: 'persist-off' });
    assert.equal(
      fs.existsSync(path.join(configDir, 'config.json')),
      false,
      "scripted 'a' answers never touch the config file"
    );

    // With persistTrust: 'a' on exec writes exec; 'a' on an edit writes the
    // whole edit family in one press; a fresh hook then runs without asking.
    const persisted = ['a', 'a'];
    setCliApprovalAsker(async () => persisted.shift() ?? '');
    const hook = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
        persistTrust: true,
      }
    );
    await hook({ ...execRequest('touch /tmp/moss-p1'), sessionKey: 'persist-on' });
    await hook({
      tool: {
        name: 'edit_file',
        description: 'Edit a file',
        inputSchema: { type: 'object', properties: {} },
        metadata: { sideEffectClass: 'local_write', planMode: 'requires_user_confirmation' },
        execute: async () => 'ok',
      },
      input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
      sessionKey: 'persist-on',
    });
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    // v0.26 (T03): 'a' persists allow rules into the user config's
    // permissions.allow block (the trustedTools write side moved, PRD W2).
    const persistedAllow = written.permissions?.allow ?? [];
    assert.ok(persistedAllow.includes('exec'), "'a' (saved) persists exec to permissions.allow");
    for (const family of ['write_file', 'edit_file', 'apply_patch', 'move_file']) {
      assert.ok(
        persistedAllow.includes(family),
        `one press on an edit persists the whole edit family (${family})`
      );
    }
    let askedAgain = false;
    setCliApprovalAsker(async () => {
      askedAgain = true;
      return '';
    });
    const fresh = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
        // v0.26: the persisted rules round-trip as a live rule table.
        permissionRules: () => ({
          rules: persistedAllow.map((spec) => parsePermissionRuleSpec(spec, 'user', 'allow')),
          sources: {},
        }),
      }
    );
    const replay = await fresh({
      ...execRequest('touch /tmp/moss-p2'),
      sessionKey: 'persist-replay',
    });
    assert.equal(askedAgain, false, 'a fresh session inherits the saved trust — no re-asking');
    assert.equal(replay.approved, true, 'the saved trust lets the command run');
    setCliApprovalAsker(null);
  } finally {
    if (prevConfigDir === undefined) delete process.env.MOSS_CONFIG_DIR;
    else process.env.MOSS_CONFIG_DIR = prevConfigDir;
    setCliApprovalAsker(null);
  }
}

console.log(
  'cli-permission-defaults.spec: v0.26 full default + legacy migration semantics + hard blocks passed'
);
