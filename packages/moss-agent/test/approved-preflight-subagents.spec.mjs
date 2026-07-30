import assert from 'node:assert/strict';
import { executeApprovedPreflightSubagents } from '../src/core/subagent/approved-preflight-subagents.ts';

const calls = [];
const progress = [];
const result = await executeApprovedPreflightSubagents({
  assignments: [
    {
      assignmentId: 'architecture',
      label: '架构专家',
      task: '检查模块边界并给出证据。',
      scope: 'read-only',
      allowedTools: ['read', 'grep'],
      model: 'gpt-specialist',
    },
    {
      assignmentId: 'device',
      label: '设备专家',
      task: '读取设备状态并给出证据。',
      scope: 'device-read',
      allowedTools: ['device_info'],
    },
    {
      assignmentId: 'unsafe',
      label: '不安全任务',
      task: '尝试获得完整权限。',
      scope: 'full',
      allowedTools: ['exec'],
    },
  ],
  spawn: async (assignment) => {
    calls.push(assignment);
    return {
      runId: `run-${assignment.assignmentId}`,
      sessionKey: `sub-${assignment.assignmentId}`,
      summary: `${assignment.label}：证据`,
      success: true,
      toolResults: 1,
    };
  },
  onProgress: (event) => progress.push(event),
});

assert.deepEqual(
  calls.map(({ assignmentId, scope }) => ({ assignmentId, scope })),
  [
    { assignmentId: 'architecture', scope: 'read-only' },
    { assignmentId: 'device', scope: 'device-read' },
  ]
);
assert.equal(result.assignments.length, 2);
assert.deepEqual(
  result.assignments.map((assignment) => assignment.status),
  ['completed', 'completed']
);
assert.deepEqual(calls[0].allowedTools, ['read', 'grep']);
assert.equal(calls[0].model, 'gpt-specialist');
assert.deepEqual(calls[1].allowedTools, ['device_info']);
assert.match(result.context, /Host-approved expert evidence/);
assert.match(result.context, /architecture/);
assert.match(result.context, /架构专家：证据/);
assert.equal(progress[0].phase, 'planned');
assert.equal(progress.at(-1).phase, 'completed');
assert.equal(
  progress.find(
    (event) => event.assignmentId === 'architecture' && event.phase === 'completed',
  )?.summary,
  '架构专家：证据',
  'terminal progress exposes the bounded expert report to the host UI',
);

const cancellationAssignments = [
  {
    assignmentId: 'kept',
    label: '完成分支',
    task: '返回证据。',
    scope: 'read-only',
    allowedTools: ['read'],
  },
  {
    assignmentId: 'stopped',
    label: '取消分支',
    task: '不应启动。',
    scope: 'read-only',
    allowedTools: ['read'],
  },
];
const partial = await executeApprovedPreflightSubagents({
  assignments: cancellationAssignments,
  isCancelled: (assignment) => assignment.assignmentId === 'stopped',
  spawn: async (assignment) => ({
    runId: `run-${assignment.assignmentId}`,
    sessionKey: `sub-${assignment.assignmentId}`,
    summary: 'evidence',
    success: true,
  }),
});
assert.equal(partial.outcome, 'partial');
assert.deepEqual(
  partial.assignments.map((assignment) => assignment.status),
  ['completed', 'cancelled']
);

let allCancelledSpawned = 0;
const allCancelled = await executeApprovedPreflightSubagents({
  assignments: cancellationAssignments,
  isCancelled: () => true,
  spawn: async () => {
    allCancelledSpawned += 1;
    throw new Error('cancelled work must not spawn');
  },
});
assert.equal(allCancelledSpawned, 0);
assert.equal(allCancelled.outcome, 'partial');
assert.deepEqual(
  allCancelled.assignments.map((assignment) => assignment.status),
  ['cancelled', 'cancelled']
);

const parentAbort = new AbortController();
parentAbort.abort();
let parentAbortedSpawned = 0;
const parentAborted = await executeApprovedPreflightSubagents({
  assignments: cancellationAssignments,
  abortSignal: parentAbort.signal,
  spawn: async () => {
    parentAbortedSpawned += 1;
    throw new Error('parent-aborted work must not spawn');
  },
});
assert.equal(parentAbortedSpawned, 0);
assert.equal(parentAborted.outcome, 'failed');
assert.deepEqual(
  parentAborted.assignments.map((assignment) => assignment.status),
  ['failed', 'failed'],
  'parent abort remains distinguishable from per-assignment cancellation'
);

console.log(
  '[PASS] approved preflight subagents are bounded, read-only, and rendered as host evidence'
);
