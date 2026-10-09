#!/usr/bin/env node
/**
 * Device safety policy integration: full mode runs read-only and reversible
 * device work, and the destructive tier asks (or refuses headless) unless
 * an allow rule, trust flag/env, or per-device allowlist says otherwise.
 * Decisions land in evidence.jsonl and the live task timeline.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCliToolApprovalHook, setCliApprovalAsker } from '../dist/cli/approval.js';
import { parseCliArgs } from '../dist/cli/args.js';
import { resolveCliConfig } from '../dist/cli/config.js';
import { setCliInteractionMode } from '../dist/cli/interaction-mode.js';
import { parsePermissionRuleSpec } from '../dist/cli/permission-rules.js';
import { resolvePermissionDecision } from '../dist/cli/permission-rules.js';
import { createDraftTask, listTaskEvents } from '../dist/core/task/task-store.js';
import { listEvidenceRecords } from '../dist/core/task-runtime/artifacts.js';
import { deviceExecTool } from '../dist/tools/device-tools.js';
import { configureDefaultDeviceTarget } from '../dist/device/device-target.js';
import { disconnectAllDevices } from '../dist/device/device-registry.js';
import { grantDeviceOperation, resetDeviceOperationGrants } from '../dist/safety/device-trust.js';
import { startInProcessSshDevice } from './helpers/in-process-ssh-device.mjs';

afterEach(() => {
  setCliApprovalAsker(null);
  setCliInteractionMode('manual');
  delete process.env.MOSS_DEVICE_TRUST;
  delete process.env.MOSS_DEVICE_TRUST_DEVICES;
});

const noRules = { rules: [], sources: {} };
const baseInput = {
  toolName: 'device_exec',
  sideEffect: 'device_mutation',
  operand: 'reboot',
  requiresApproval: true,
  readOnlyCeiling: false,
  boardMode: false,
  acceptEditsEligible: false,
  planModeAllowed: false,
};

function tool(name, sideEffect = 'device_mutation') {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: sideEffect, planMode: 'requires_user_confirmation' },
    execute: async () => 'ok',
  };
}

async function tmpWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-device-policy-'));
}

test('decision order: destructive tier asks in full unless trusted or allowed', () => {
  const destructive = { ...baseInput, mode: 'full', deviceRiskTier: 'destructive' };
  assert.deepEqual(resolvePermissionDecision(destructive, noRules), {
    decision: 'ask',
    reason: 'device-destructive',
  });
  assert.equal(
    resolvePermissionDecision({ ...destructive, deviceFullTrust: true }, noRules).decision,
    'allow'
  );
  const allow = parsePermissionRuleSpec('device_exec(reboot)', 'user', 'allow');
  assert.equal(
    resolvePermissionDecision(destructive, { rules: [allow], sources: {} }).decision,
    'allow'
  );
  const deny = parsePermissionRuleSpec('device_exec(reboot)', 'user', 'deny');
  const denied = resolvePermissionDecision(
    { ...destructive, deviceFullTrust: true },
    { rules: [deny], sources: {} }
  );
  assert.equal(denied.decision, 'deny');
  assert.equal(
    resolvePermissionDecision(
      {
        ...baseInput,
        mode: 'full',
        deviceRiskTier: 'reversible',
        operand: 'systemctl restart app',
      },
      noRules
    ).decision,
    'allow'
  );
  assert.equal(
    resolvePermissionDecision(
      { ...baseInput, mode: 'plan', deviceRiskTier: 'destructive' },
      noRules
    ).decision,
    'block'
  );
});

test('full mode runs reversible device work and refuses destructive headless', async () => {
  setCliInteractionMode('full');
  const ws = await tmpWorkspace();
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: ws });
  const restart = await hook({
    tool: tool('device_exec'),
    input: { command: 'systemctl restart robot' },
    sessionKey: 'rev',
  });
  assert.equal(restart.approved, true, 'reversible systemctl restart runs in full');
  const buildRm = await hook({
    tool: tool('device_exec'),
    input: { command: 'rm -rf dist' },
    sessionKey: 'rm-dist',
  });
  assert.equal(buildRm.approved, true, 'rm of a build dir is reversible');
  const probe = await hook({
    tool: tool('device_info', 'readonly'),
    input: {},
    sessionKey: 'info',
  });
  assert.equal(probe.approved, true, 'read-only device probe runs');
  const reboot = await hook({
    tool: tool('device_exec'),
    input: { command: 'sudo reboot' },
    sessionKey: 'reboot',
  });
  assert.equal(reboot.approved, false);
  assert.match(reboot.reason, /MOSS_DEVICE_TRUST/);
  assert.match(reboot.reason, /--trust-device/);
  assert.doesNotMatch(reboot.reason, /switch the mode to full/i);
  const evidence = await listEvidenceRecords(ws, 20);
  const decisions = evidence.filter((record) => record.metric === 'device_policy');
  assert.ok(decisions.length >= 4, 'every device decision is evidence');
  assert.ok(
    decisions.some((record) => record.observed === 'destructive:deny' && record.result === 'fail')
  );
  assert.ok(
    decisions.some((record) => record.observed === 'reversible:allow' && record.result === 'pass')
  );
  setCliInteractionMode('manual');
});

test('modes: manual and acceptEdits ask, plan blocks, full asks only the destructive tier', async () => {
  const ws = await tmpWorkspace();
  const call = async (mode, command) => {
    setCliInteractionMode(mode);
    const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: ws });
    return hook({
      tool: tool('device_exec'),
      input: { command },
      sessionKey: `${mode}-${command}`,
    });
  };
  const manual = await call('manual', 'systemctl restart robot');
  assert.equal(manual.approved, false);
  assert.match(manual.reason, /non-interactively|requires approval/i);
  const edits = await call('acceptEdits', 'reboot');
  assert.equal(edits.approved, false);
  assert.match(edits.reason, /MOSS_DEVICE_TRUST|non-interactively/);
  const plan = await call('plan', 'reboot');
  assert.equal(plan.approved, false);
  assert.match(plan.reason, /plan mode/i);
  setCliInteractionMode('manual');
});

test('TTY confirmation and session device trust', async () => {
  setCliInteractionMode('full');
  const answers = ['n', 'y', 'a', ''];
  setCliApprovalAsker(async () => answers.shift() ?? 'n');
  const ws = await tmpWorkspace();
  const hook = createCliToolApprovalHook(
    'workspace-write',
    {},
    { workspaceDir: ws, device: { host: '192.168.1.10' } }
  );
  const denied = await hook({
    tool: tool('device_exec'),
    input: { command: 'reboot' },
    sessionKey: 'no',
  });
  assert.equal(denied.approved, false);
  const once = await hook({
    tool: tool('device_exec'),
    input: { command: 'reboot' },
    sessionKey: 'yes',
  });
  assert.equal(once.approved, true, 'y allows this destructive call');
  const trusted = await hook({
    tool: tool('device_exec'),
    input: { command: 'poweroff' },
    sessionKey: 'trust',
  });
  assert.equal(trusted.approved, true, 'a trusts the device');
  const later = await hook({
    tool: tool('device_exec'),
    input: { command: 'systemctl stop ssh' },
    sessionKey: 'later',
  });
  assert.equal(later.approved, true, 'session device trust covers the next destructive call');
  setCliApprovalAsker(null);
  setCliInteractionMode('manual');
});

test('explicit trust: env, per-device allowlist, and --trust-device', async () => {
  setCliInteractionMode('full');
  const ws = await tmpWorkspace();
  const envHook = createCliToolApprovalHook(
    'workspace-write',
    { MOSS_DEVICE_TRUST: 'full' },
    {
      workspaceDir: ws,
    }
  );
  const fromEnv = await envHook({
    tool: tool('device_exec'),
    input: { command: 'reboot' },
    sessionKey: 'env',
  });
  assert.equal(fromEnv.approved, true, 'MOSS_DEVICE_TRUST=full allows reboot');

  const listed = createCliToolApprovalHook(
    'workspace-write',
    {},
    {
      workspaceDir: ws,
      device: { host: 'board.local' },
      trustedDevices: ['board.local'],
    }
  );
  assert.equal(
    (
      await listed({
        tool: tool('device_exec'),
        input: { command: 'reboot' },
        sessionKey: 'list',
      })
    ).approved,
    true
  );
  const other = createCliToolApprovalHook(
    'workspace-write',
    {},
    {
      workspaceDir: ws,
      device: { host: 'other.local' },
      trustedDevices: ['board.local'],
    }
  );
  assert.equal(
    (
      await other({
        tool: tool('device_exec'),
        input: { command: 'reboot' },
        sessionKey: 'other',
      })
    ).approved,
    false
  );

  const parsed = parseCliArgs(['--trust-device']);
  assert.equal(parsed.configOverrides.deviceTrust, 'full');
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    { permissions: { deviceTrust: 'gated', trustedDevices: ['rdk-1'] } },
    parsed.configOverrides
  );
  assert.equal(resolved.permissions.deviceTrust, 'full');
  assert.deepEqual(resolved.permissions.trustedDevices, ['rdk-1']);
  const fromConfig = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1', MOSS_DEVICE_TRUST_DEVICES: '10.0.0.8' },
    { permissions: { trustedDevices: ['rdk-1'] } },
    {}
  );
  assert.deepEqual(fromConfig.permissions.trustedDevices, ['rdk-1', '10.0.0.8']);
  setCliInteractionMode('manual');
});

test('live task timeline records the device policy decision', async () => {
  setCliInteractionMode('full');
  const ws = await tmpWorkspace();
  const task = await createDraftTask(ws, 'deploy the camera node');
  const hook = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: ws });
  await hook({
    tool: tool('device_exec'),
    input: { command: 'reboot' },
    sessionKey: 'timeline',
  });
  const events = await listTaskEvents(ws, task.taskId);
  const note = events.find(
    (event) => event.type === 'note' && event.data && event.data.kind === 'device_policy'
  );
  assert.ok(note, 'timeline has a device_policy note');
  assert.equal(note.data.tier, 'destructive');
  assert.equal(note.data.decision, 'deny');
  assert.equal(note.phase, 'draft', 'info note does not move the phase');
  setCliInteractionMode('manual');
});

test('device_exec backstop blocks destructive calls the hook did not grant', async (t) => {
  resetDeviceOperationGrants();
  const passwordEnv = 'MOSS_TEST_DEVICE_POLICY_PASSWORD';
  process.env[passwordEnv] = 'swordfish';
  delete process.env.MOSS_DEVICE_TRUST;
  delete process.env.MOSS_DEVICE_TRUST_DEVICES;
  const device = await startInProcessSshDevice({
    commands: {
      reboot: { stdout: 'rebooting\n', exit: 0 },
      'echo ok': { stdout: 'ok\n', exit: 0 },
    },
  });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
    delete process.env[passwordEnv];
    delete process.env.MOSS_DEVICE_TRUST;
    configureDefaultDeviceTarget(null);
    resetDeviceOperationGrants();
  });
  configureDefaultDeviceTarget({
    deviceId: 'policy-board',
    kind: 'linux',
    host: '127.0.0.1',
    port: device.port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: passwordEnv },
  });
  const ctx = {
    workspaceDir: os.tmpdir(),
    sessionKey: 'device-policy',
    abortSignal: new AbortController().signal,
  };
  const blocked = await deviceExecTool.execute({ command: 'reboot' }, ctx);
  assert.match(blocked, /^Command blocked:/);
  const benign = await deviceExecTool.execute({ command: 'echo ok' }, ctx);
  assert.match(benign, /ok/);
  grantDeviceOperation('device_exec', 'reboot');
  const granted = await deviceExecTool.execute({ command: 'reboot' }, ctx);
  assert.match(granted, /rebooting/);
  process.env.MOSS_DEVICE_TRUST = 'full';
  const trusted = await deviceExecTool.execute({ command: 'reboot' }, ctx);
  assert.match(trusted, /rebooting/);
});
