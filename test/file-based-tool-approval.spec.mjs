#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// CLI config normally loads ancestor .env files at module import. This test
// must exercise approval without reading any developer or workspace .env file.
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-file-tool-config-'));
const previousConfigFile = process.env.MOSS_CONFIG_FILE;
process.env.MOSS_CONFIG_FILE = path.join(configRoot, 'config.json');
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...options) {
  if (typeof file === 'string' && path.basename(file) === '.env') {
    const error = new Error('dotenv disabled in file-based tool approval test');
    error.code = 'ENOENT';
    throw error;
  }
  return readFileSync.call(this, file, ...options);
};
let createCliToolApprovalHook;
let executeOneToolCall;
let ToolRegistry;
let registerFileBasedTools;
let parsePermissionRuleSpec;
let PermissionRuleRegistry;
let setCliApprovalViewAsker;
try {
  ({ createCliToolApprovalHook } = await import('../dist/cli/approval.js'));
  ({ executeOneToolCall } = await import('../dist/core/tools/execute-tool-call.js'));
  ({ ToolRegistry } = await import('../dist/core/tools/tool-registry.js'));
  ({ registerFileBasedTools } = await import('../dist/tools/file-based-tools.js'));
  ({ parsePermissionRuleSpec, PermissionRuleRegistry } =
    await import('../dist/cli/permission-rules.js'));
  ({ setCliApprovalViewAsker } = await import('../dist/cli/approval-view.js'));
} finally {
  fs.readFileSync = readFileSync;
  if (previousConfigFile === undefined) delete process.env.MOSS_CONFIG_FILE;
  else process.env.MOSS_CONFIG_FILE = previousConfigFile;
  fs.rmSync(configRoot, { recursive: true, force: true });
}

function createFixture(t, metadata = {}) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-file-tool-approval-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const command = path.join(workspaceDir, 'synthetic-tool');
  const marker = path.join(workspaceDir, 'marker.txt');
  fs.writeFileSync(command, '#!/bin/sh\nprintf "synthetic marker\\n" >> marker.txt\n', {
    mode: 0o700,
  });
  const toolsDir = path.join(workspaceDir, '.moss', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolsDir, 'synthetic.tool.json'),
    JSON.stringify({
      name: 'synthetic_marker',
      description: 'Write a harmless marker in this temporary workspace.',
      command,
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      ...metadata,
    })
  );
  const registry = new ToolRegistry();
  registerFileBasedTools(workspaceDir, registry, (name) => {
    throw new Error(`unexpected tool collision: ${name}`);
  });
  const tool = registry.get('synthetic_marker');
  assert.ok(tool);
  return { workspaceDir, marker, command, tool };
}

function createFixtureHook(
  fixture,
  {
    mode = 'manual',
    readOnlyCeiling = false,
    asker,
    rules = [],
    trustedTools = [],
    sessionPermissionRules,
  } = {}
) {
  const hook = createCliToolApprovalHook(
    'workspace-write',
    { MOSS_CONFIG_DIR: path.join(fixture.workspaceDir, 'config') },
    {
      workspaceDir: fixture.workspaceDir,
      interactionMode: () => mode,
      readOnlyCeiling,
      trustedTools,
      sessionPermissionRules,
      permissionRules: () => ({ rules, sources: {} }),
      printMode: !asker,
      detailMode: 'quiet',
    }
  );
  if (asker) hook.setAsker(asker);
  return hook;
}

async function executeFixture(fixture, options = {}) {
  const hook = options.hook ?? createFixtureHook(fixture, options);
  const abortSignal = new AbortController().signal;
  const outcome = await executeOneToolCall(
    { id: 'synthetic-call', name: fixture.tool.name, input: options.input ?? {} },
    {
      toolsForRun: [fixture.tool],
      toolCtx: { workspaceDir: fixture.workspaceDir, sessionKey: 'synthetic-session' },
      sessionKey: 'synthetic-session',
      abortSignal,
      toolTimeoutMs: 5_000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1_000,
      skipHeartbeatToolNames: new Set(),
      async checkToolApproval(call) {
        const decision = await hook({
          tool: call.tool,
          input: call.input,
          sessionKey: 'synthetic-session',
          toolCallId: call.id,
          abortSignal: call.abortSignal,
        });
        return decision.approved ? null : { ...decision, decision: 'deny' };
      },
      push() {},
    }
  );
  return outcome;
}

test('file-based commands cannot run unapproved in manual, plan, or read-only modes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const cases = [
    ['default manual', {}, {}],
    ['readonly manual', { sideEffect: 'readonly', planMode: 'allow' }, {}],
    ['readonly plan', { sideEffect: 'readonly', planMode: 'allow' }, { mode: 'plan' }],
    ['readonly ceiling', { sideEffect: 'readonly', planMode: 'allow' }, { readOnlyCeiling: true }],
    ['runtime plan', { sideEffect: 'runtime_state', planMode: 'allow' }, { mode: 'plan' }],
    ['local write plan', { sideEffect: 'local_write', planMode: 'allow' }, { mode: 'plan' }],
  ];
  const actual = [];
  for (const [name, metadata, options] of cases) {
    const fixture = createFixture(t, metadata);
    const outcome = await executeFixture(fixture, options);
    const markerWritten = fs.existsSync(fixture.marker);
    if (markerWritten) assert.equal(fs.readFileSync(fixture.marker, 'utf8'), 'synthetic marker\n');
    actual.push({ name, outcome: outcome.kind, markerWritten });
  }
  assert.deepEqual(
    actual,
    cases.map(([name]) => ({ name, outcome: 'denied', markerWritten: false }))
  );
});

test('manual approval identifies the executable before running it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const fixture = createFixture(t, { sideEffect: 'readonly', planMode: 'allow' });
  let prompt;
  let dialog;
  const outcome = await executeFixture(fixture, {
    input: { command: 'untrusted input' },
    asker: async (question, _signal, structuredDialog) => {
      assert.equal(fs.existsSync(fixture.marker), false, 'the command has not run before approval');
      prompt = question;
      dialog = structuredDialog;
      return 'n';
    },
  });
  assert.equal(outcome.kind, 'denied');
  assert.equal(fs.existsSync(fixture.marker), false);
  assert.ok(prompt, 'manual mode asked for approval');
  assert.ok(prompt.includes(fixture.command), 'text prompt identifies the configured executable');
  assert.ok(
    dialog.detail.some((line) => line.includes(fixture.command)),
    'structured prompt identifies the configured executable'
  );
  assert.match(prompt, /not sandboxed/i);
  assert.match(dialog.scope, /not sandboxed/i);
});

test('structured approval view identifies the unsandboxed executable', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const fixture = createFixture(t);
  let view;
  const uninstall = setCliApprovalViewAsker(async (approvalView) => {
    view = approvalView;
    return 'n';
  });
  let outcome;
  try {
    outcome = await executeFixture(fixture, {
      asker: async () => {
        throw new Error('structured approval should take precedence');
      },
    });
  } finally {
    uninstall();
  }
  assert.equal(outcome.kind, 'denied');
  assert.equal(fs.existsSync(fixture.marker), false);
  assert.ok(
    view.preview.some((line) => line.includes(fixture.command) && /not sandboxed/i.test(line))
  );
});

test('manual approval runs once only after the user accepts', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const fixture = createFixture(t);
  let prompts = 0;
  const outcome = await executeFixture(fixture, {
    asker: async () => {
      prompts += 1;
      assert.equal(fs.existsSync(fixture.marker), false);
      return 'y';
    },
  });
  assert.equal(prompts, 1);
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.isError, false);
  assert.equal(fs.readFileSync(fixture.marker, 'utf8'), 'synthetic marker\n');
});

test('manual session grant continues to authorize the named file-based tool', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const fixture = createFixture(t, { sideEffect: 'runtime_state', planMode: 'allow' });
  let prompts = 0;
  const hook = createFixtureHook(fixture, {
    sessionPermissionRules: new PermissionRuleRegistry(),
    asker: async () => {
      prompts += 1;
      return 'a';
    },
  });
  assert.equal((await executeFixture(fixture, { hook })).kind, 'completed');
  assert.equal((await executeFixture(fixture, { hook })).kind, 'completed');
  assert.equal(prompts, 1, 'the explicit session grant prevents a second prompt');
  assert.equal(fs.readFileSync(fixture.marker, 'utf8'), 'synthetic marker\nsynthetic marker\n');
});

test('full and explicit allow work while deny and mode ceilings still win', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const allow = parsePermissionRuleSpec('synthetic_marker', 'user', 'allow');
  const deny = parsePermissionRuleSpec('synthetic_marker', 'user', 'deny');
  const cases = [
    ['full', { mode: 'full' }, true],
    ['manual allow rule', { rules: [allow] }, true],
    ['manual legacy trustedTools', { trustedTools: ['synthetic_marker'] }, true],
    ['manual allow and deny', { rules: [allow, deny] }, false],
    ['full allow and deny', { mode: 'full', rules: [allow, deny] }, false],
    ['plan with allow', { mode: 'plan', rules: [allow] }, false],
    ['read-only ceiling with allow', { readOnlyCeiling: true, rules: [allow] }, false],
    ['full under read-only ceiling', { mode: 'full', readOnlyCeiling: true }, false],
    ['accept-edits without allow', { mode: 'acceptEdits' }, false],
  ];
  for (const [name, options, shouldRun] of cases) {
    const fixture = createFixture(t, { sideEffect: 'readonly', planMode: 'allow' });
    const outcome = await executeFixture(fixture, options);
    assert.equal(outcome.kind, shouldRun ? 'completed' : 'denied', name);
    assert.equal(fs.existsSync(fixture.marker), shouldRun, name);
    if (shouldRun) {
      assert.equal(outcome.isError, false, name);
      assert.equal(fs.readFileSync(fixture.marker, 'utf8'), 'synthetic marker\n', name);
    }
  }
});

test('ordinary SDK tool metadata keeps its existing plan-mode semantics', async (t) => {
  const fixture = createFixture(t);
  const hook = createFixtureHook(fixture, { mode: 'plan' });
  for (const sideEffectClass of ['readonly', 'runtime_state', 'local_write']) {
    const tool = {
      name: `embedded_${sideEffectClass}`,
      description: 'An ordinary host-defined tool.',
      metadata: { sideEffectClass, planMode: 'allow' },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    };
    const decision = await hook({ tool, input: {}, sessionKey: 'embedded-session' });
    assert.equal(decision.approved, true, sideEffectClass);
  }
});

test('an ask rule takes precedence over allow in manual mode', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the synthetic executable uses a POSIX shell script');
    return;
  }
  const fixture = createFixture(t);
  const ask = parsePermissionRuleSpec('synthetic_marker', 'user', 'ask');
  const allow = parsePermissionRuleSpec('synthetic_marker', 'user', 'allow');
  let prompts = 0;
  const outcome = await executeFixture(fixture, {
    rules: [allow, ask],
    asker: async () => {
      prompts += 1;
      return 'n';
    },
  });
  assert.equal(prompts, 1);
  assert.equal(outcome.kind, 'denied');
  assert.equal(fs.existsSync(fixture.marker), false);
});
