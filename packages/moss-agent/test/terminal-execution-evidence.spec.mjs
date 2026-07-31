#!/usr/bin/env node
import assert from 'node:assert/strict';
import { extractLatestTerminalExecutionEvidence } from '../dist/cli/terminal-execution-evidence.js';

const assistantClaimOnly = [
  { role: 'assistant', content: [{ type: 'text', text: 'exit_code: 0\ndeploy complete' }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(assistantClaimOnly), undefined);

const completedExec = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'exec', input: { command: 'deploy' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'deploy complete', is_error: false }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(completedExec), {
  source: 'exec',
  toolUseId: 'tool-1',
  exitCode: 0,
  stdout: 'deploy complete',
  stderr: '',
});

const payloadForms = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-text', name: 'exec', input: { command: 'printf ok' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-text', text: 'top-level text', is_error: false }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-array', name: 'exec', input: { command: 'printf parts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-array', content: ['first', 'second'], is_error: false }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(payloadForms), {
  source: 'exec',
  toolUseId: 'tool-array',
  exitCode: 0,
  stdout: 'first\nsecond',
  stderr: '',
});

const execWithMultilineStderr = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-stderr', name: 'exec', input: { command: 'build' } }] },
  { role: 'user', content: [{
    type: 'tool_result',
    tool_use_id: 'tool-stderr',
    is_error: false,
    content: 'line one\nline two\n\n--- stderr ---\nwarning one\nwarning two',
  }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(execWithMultilineStderr), {
  source: 'exec',
  toolUseId: 'tool-stderr',
  exitCode: 0,
  stdout: 'line one\nline two',
  stderr: 'warning one\nwarning two',
});

const laterFailure = [
  ...completedExec,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'exec', input: { command: 'verify' } }] },
  { role: 'user', content: [{
    type: 'tool_result',
    tool_use_id: 'tool-2',
    is_error: true,
    content: 'exit_code: 2\npartial output\n\n--- stderr ---\nbroken line one\nbroken line two',
  }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(laterFailure), {
  source: 'exec',
  toolUseId: 'tool-2',
  exitCode: 2,
  stdout: 'partial output',
  stderr: 'broken line one\nbroken line two',
});

const thrownExecFailure = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-failed', name: 'exec', input: { command: 'verify' } }] },
  { role: 'user', content: [{
    type: 'tool_result',
    tool_use_id: 'tool-failed',
    is_error: true,
    content: 'Command failed (exit 7):\nfirst failure line\nsecond failure line',
  }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(thrownExecFailure), {
  source: 'exec',
  toolUseId: 'tool-failed',
  exitCode: 7,
  stdout: 'first failure line\nsecond failure line',
  stderr: '',
});

const immediateBackgroundExit = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-bg-exit', name: 'exec_background', input: { command: 'npm test' } }] },
  { role: 'user', content: [{
    type: 'tool_result',
    tool_use_id: 'tool-bg-exit',
    is_error: false,
    content: 'Background command bg_1 exited immediately (exit 0).\n--- output (last 20 lines) ---\nall tests passed\nsummary line',
  }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(immediateBackgroundExit), {
  source: 'exec_background',
  toolUseId: 'tool-bg-exit',
  exitCode: 0,
  stdout: 'all tests passed\nsummary line',
  stderr: '',
});

const staleThenStillRunning = [
  ...completedExec,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-bg', name: 'exec_background', input: { command: 'npm test' } }] },
  { role: 'user', content: [{
    type: 'tool_result',
    tool_use_id: 'tool-bg',
    is_error: false,
    content: 'Started bg_123 (pid 42). Still running after 1200ms. You will be notified when it finishes; use exec_logs("bg_123") to monitor and exec_stop("bg_123") to terminate.\n--- output (last 20 lines) ---\nstarting tests',
  }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(staleThenStillRunning), undefined);

const mainExecBackgroundStillRunning = [
  ...completedExec,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-main-bg', name: 'exec', input: { command: 'npm test', run_in_background: true } }] },
  { role: 'user', content: [{
    type: 'tool_result',
    tool_use_id: 'tool-main-bg',
    is_error: false,
    content: 'Started bg_456 (pid 84). Still running after 1200ms. You will be notified when it finishes; use exec_logs("bg_456") to monitor and exec_stop("bg_456") to terminate.',
  }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(mainExecBackgroundStillRunning), undefined);

console.log('terminal execution evidence extraction passed');
