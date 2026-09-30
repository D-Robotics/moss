#!/usr/bin/env node
/**
 * Task OS M11 (§11 approval as task experience): the approval prompt carries
 * the task context — operation, task, target device, reason, impact, and
 * what happens if declined. Device tools expose a `reason` channel the
 * agent fills; without task/reason the legacy prompt stays unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskApprovalBlock, renderCliApprovalPrompt } from '../dist/cli/approval.js';
import { deviceTools, deviceDeployTool } from '../dist/tools/device-tools.js';

function preview(overrides = {}) {
  return {
    toolName: 'device_exec',
    sideEffect: 'device_mutation',
    decisionContext: 'device mutation requires approval',
    acceptEditsEligible: false,
    workspaceFileMutation: false,
    ...overrides,
  };
}

test('task context block renders operation/task/reason/impact/decline', () => {
  const lines = buildTaskApprovalBlock(
    preview(),
    {
      command: 'systemctl restart perception',
      reason: 'new build deployed; restart to start verification',
    },
    {
      taskId: 'task_x',
      goal: 'Optimize camera FPS on RDK',
      phase: 'verifying',
      attempt: 2,
      targetDeviceId: 'rdk-x5-001',
    }
  );
  const text = lines.join('\n');
  assert.match(text, /Task context:/);
  assert.match(text, /operation: run a command on the device — systemctl restart perception/);
  assert.match(text, /task: Optimize camera FPS on RDK \(verifying, attempt 2\)/);
  assert.match(text, /target device: rdk-x5-001/);
  assert.match(text, /reason: new build deployed; restart to start verification/);
  assert.match(text, /impact: the affected device service will be interrupted/);
  assert.match(text, /if declined: the task stays blocked/);
});

test('impact derivation: deploy overwrite and default device change', () => {
  const deploy = buildTaskApprovalBlock(
    preview({ toolName: 'device_deploy' }),
    { remote_path: '/opt/app/bin/app' },
    { taskId: 't', goal: 'g', phase: 'executing' }
  ).join('\n');
  assert.match(
    deploy,
    /impact: the file at \/opt\/app\/bin\/app on the device will be overwritten/
  );
  assert.match(deploy, /reason: required by the current task plan step/);

  const generic = buildTaskApprovalBlock(
    preview(),
    { command: 'rm /tmp/x' },
    { taskId: 't', goal: 'g', phase: 'executing' }
  ).join('\n');
  assert.match(generic, /impact: device state changes/);
});

test('no task and no reason → legacy prompt unchanged', () => {
  assert.deepEqual(buildTaskApprovalBlock(preview(), { command: 'ls' }), []);
  const rendered = renderCliApprovalPrompt(preview(), { command: 'ls' });
  assert.doesNotMatch(rendered, /Task context:/);
});

test('device mutating tools expose the reason channel', () => {
  const exec = deviceTools.find((tool) => tool.name === 'device_exec');
  const write = deviceTools.find((tool) => tool.name === 'device_file_write');
  for (const tool of [exec, write, deviceDeployTool]) {
    assert.ok(tool, `${tool} registered`);
    assert.ok(
      tool.inputSchema.properties.reason,
      `${tool.name} exposes reason for the approval prompt`
    );
  }
});
