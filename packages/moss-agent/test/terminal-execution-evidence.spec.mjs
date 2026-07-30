#!/usr/bin/env node
import assert from 'node:assert/strict';
import { extractLatestTerminalExecutionEvidence } from '../dist/cli/terminal-execution-evidence.js';

const assistantClaimOnly = [
  { role: 'assistant', content: [{ type: 'text', text: 'exit_code: 0\ndeploy complete' }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(assistantClaimOnly), undefined);

const completedExec = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'exec', input: { command: 'deploy' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'exit_code: 0\ndeploy complete' }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(completedExec), {
  source: 'exec',
  toolUseId: 'tool-1',
  exitCode: 0,
  stdout: 'deploy complete',
  stderr: '',
});

const backgroundStillRunning = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-bg', name: 'exec_background', input: { command: 'npm test' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-bg', content: 'Started bg_123. Still running.' }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(backgroundStillRunning), undefined);

const laterFailure = [
  ...completedExec,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'exec', input: { command: 'verify' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'exit_code: 2\nstdout: partial\nstderr: broken' }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(laterFailure), {
  source: 'exec',
  toolUseId: 'tool-2',
  exitCode: 2,
  stdout: 'partial',
  stderr: 'broken',
});

console.log('terminal execution evidence extraction passed');
