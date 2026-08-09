#!/usr/bin/env node
/**
 * batch-device — fleet_batch exec safety gate + shellEscape primitive.
 *
 * Pins down two security fixes:
 *  (1) `fleet_batch exec` now runs `isCommandDangerous` before fanning a
 *      command across the fleet (previously it skipped the check that
 *      `device_exec` has, so `fleet_batch exec "rm -rf /"` would run on every
 *      board with no gate).
 *  (2) `shellEscape` (used by `gatherFileFromDevice` after the fix) produces a
 *      single-quoted, injection-safe token — `cat "${filePath}"` previously
 *      allowed `$(...)` / backtick injection from the LLM-supplied path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';
import { createBatchDeviceTool } from '../dist/tools/batch-device.js';
import { shellEscape } from '../dist/tools/ssh-utils.js';

const ctx = () => ({ abortSignal: new AbortController().signal });

// A disconnected device so exec proceeds past the "no devices" guard but does
// not attempt a real SSH connection (the safety check must fire before any
// device dispatch).
const tool = createBatchDeviceTool([
  { alias: 'd1', connected: false, config: { host: 'h', user: 'u', port: 22 } },
]);

function executeDeps(checkedTool, checkToolApproval, events) {
  return {
    toolsForRun: [checkedTool],
    toolCtx: { workspaceDir: process.cwd(), sessionKey: 'fleet-batch-test' },
    sessionKey: 'fleet-batch-test',
    abortSignal: new AbortController().signal,
    toolTimeoutMs: 5_000,
    enableHeartbeat: false,
    heartbeatIntervalMs: 60_000,
    skipHeartbeatToolNames: new Set(['fleet_batch']),
    checkToolApproval,
    push: (event) => events.push(event),
  };
}

function approvalAdapter(hook, checkedTool) {
  return async (call) => {
    const result = await hook({
      tool: checkedTool,
      input: call.input,
      sessionKey: 'fleet-batch-test',
      toolCallId: call.id,
      abortSignal: call.abortSignal,
    });
    return {
      ...result,
      decision: result.approved ? 'allow-once' : 'deny',
    };
  };
}

test('fleet_batch Plan denial stops the real execution pipeline before tool.execute', async () => {
  assert.equal(
    tool.metadata?.planMode,
    'requires_user_confirmation',
    'fleet-wide execution must leave Plan mode and pass the normal approval path'
  );
  let executions = 0;
  const checkedTool = {
    ...tool,
    async execute(input, context) {
      executions++;
      return tool.execute(input, context);
    },
  };
  const events = [];
  const planHook = createCliToolApprovalHook(
    'workspace-write',
    {},
    { workspaceDir: process.cwd(), interactionMode: () => 'plan' }
  );
  const outcome = await executeOneToolCall(
    {
      id: 'fleet-plan-deny',
      name: 'fleet_batch',
      input: { action: 'exec', command: 'touch /tmp/moss-plan-mode-must-not-run' },
    },
    executeDeps(checkedTool, approvalAdapter(planHook, checkedTool), events)
  );

  assert.equal(outcome.kind, 'denied');
  assert.equal(executions, 0, 'approval denial must prevent tool.execute and SSH dispatch');
  assert.equal(
    events.some((event) => event.type === 'tool_execution_start'),
    false,
    'denied calls never emit execution start'
  );
});

test('fleet_batch Execute mode passes approval and reaches safe dispatch once', async () => {
  let executions = 0;
  const checkedTool = {
    ...tool,
    async execute(input, context) {
      executions++;
      return tool.execute(input, context);
    },
  };
  const events = [];
  const executeHook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      approvalPolicy: 'never',
      boardMode: () => true,
      interactionMode: () => 'default',
    }
  );
  const outcome = await executeOneToolCall(
    { id: 'fleet-execute', name: 'fleet_batch', input: { action: 'exec', command: 'ls -la' } },
    executeDeps(checkedTool, approvalAdapter(executeHook, checkedTool), events)
  );

  assert.equal(outcome.kind, 'completed');
  assert.equal(executions, 1, 'approved safe command reaches tool.execute exactly once');
  assert.match(outcome.text, /unreachable|not connected/i);
});

// ─── 1. fleet_batch exec blocks dangerous commands before fleet dispatch ────
test('fleet_batch blocks dangerous commands before fleet dispatch', async () => {
  for (const cmd of ['rm -rf /', 'rm -rf -- /', 'rm -rf $HOME', 'mkfs /dev/sda', ':(){ :|:& };:']) {
    const out = await tool.execute({ action: 'exec', command: cmd }, ctx());
    assert.match(out, /Command blocked/i, `dangerous command blocked: ${cmd}`);
  }
});

// ─── 2. a safe command is NOT blocked (reaches the device-dispatch path) ────
test('fleet_batch lets a safe command reach device dispatch', async () => {
  const out = await tool.execute({ action: 'exec', command: 'ls -la' }, ctx());
  assert.doesNotMatch(out, /Command blocked/i, 'safe command is not blocked by the safety gate');
  // The disconnected device yields an "unreachable" status, proving the command
  // proceeded past the gate to device dispatch (rather than being blocked).
  assert.match(
    out,
    /unreachable|not connected/i,
    'safe command reached device dispatch (device unreachable)'
  );
});

// ─── 3. shellEscape produces single-quoted, injection-safe tokens ──────────
test('shellEscape produces one injection-safe shell token', () => {
  assert.equal(shellEscape('foo'), "'foo'", 'plain arg is single-quoted');
  // An injection payload ends up literally inside single quotes, so `$(...)`
  // is not evaluated when the token is used as a shell argument.
  const payload = '$(rm -rf /)';
  const escaped = shellEscape(payload);
  assert.ok(escaped.startsWith("'") && escaped.endsWith("'"), 'escaped token is single-quoted');
  assert.ok(escaped.includes(payload), 'payload is literally inside the quotes (not evaluated)');
  // A single quote inside the arg is escaped POSIX-style ("'" -> '\'').
  assert.equal(shellEscape("a'b"), "'a'\\''b'", 'internal single quote is escaped');
});
