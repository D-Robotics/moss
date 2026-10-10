import type { AcceptanceCriterion, TaskContract, TaskContractStatus } from '../contracts/task.js';
import { formatAcceptanceVerdict } from '../contracts/task.js';
import type { TaskPlanStep } from '../contracts/task-runtime.js';
import { isTerminalTaskPhase } from '../contracts/task-runtime.js';
import type { Tool } from '../core/tools/tool-types.js';
import { appendTaskRecord, listTaskRecords } from '../core/task-runtime/artifacts.js';
import {
  appendTaskEvent,
  getTaskStateSnapshot,
  listFailures,
  recordFailure,
  recordRepair,
  tryAppendTaskEvent,
  emitAcceptanceLifecycle,
} from '../core/task/task-store.js';
import { evaluateContractAcceptance } from '../core/task/verdict.js';

// Canonical artifact IO lives in core (shared task runtime); re-exported here
// to keep the SDK surface stable.
export { appendTaskRecord, listTaskRecords } from '../core/task-runtime/artifacts.js';

/**
 * Task contract tools (robotics closed loop P0-1/P0-2, Task OS M4): define
 * the task as a machine-checkable object, gate completion on acceptance
 * evaluated against recorded evidence, and keep the unified task runtime's
 * lifecycle in sync — the agent never self-certifies.
 */

function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseCriteria(raw: unknown): AcceptanceCriterion[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'acceptance_criteria must be a non-empty array of {metric, expected, required?, description?}.';
  }
  const criteria: AcceptanceCriterion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null)
      return 'each acceptance criterion must be an object.';
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.metric !== 'string' || !candidate.metric.trim()) {
      return 'each acceptance criterion needs a non-empty metric.';
    }
    if (typeof candidate.expected !== 'string' || !candidate.expected.trim()) {
      return `criterion "${candidate.metric}" needs an expectation expression (e.g. ">=30").`;
    }
    criteria.push({
      metric: candidate.metric.trim(),
      expected: candidate.expected.trim(),
      ...(candidate.required === false ? { required: false } : {}),
      ...(typeof candidate.description === 'string' && candidate.description.trim()
        ? { description: candidate.description.trim() }
        : {}),
    });
  }
  return criteria;
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );
  return items.length ? items : undefined;
}

export const taskDefineTool: Tool = {
  name: 'task_define',
  description:
    'Define or update a task contract. Only for /goal or an explicit request for a task contract — not ordinary edits.\n' +
    'acceptance_criteria are machine-checked metrics ({metric, expected}). Operators: numeric >= <= > < == != (for example >=30 or ==4); string == and != (for example ==hi); contains; not-contains; exists; matches. Redefining a task_id updates it in place.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The user-level goal in one or two sentences' },
      acceptance_criteria: {
        type: 'array',
        description:
          'What "done" means, checkable against evidence: [{metric, expected, required?, description?}]. expected supports numeric >= <= > < == !=, string == and != (e.g. ==hi), contains, not-contains, exists, matches.',
        items: {
          type: 'object',
          properties: {
            metric: { type: 'string' },
            expected: { type: 'string' },
            required: { type: 'boolean' },
            description: { type: 'string' },
          },
          required: ['metric', 'expected'],
        },
      },
      constraints: { type: 'array', items: { type: 'string' } },
      target_device: { type: 'string', description: 'Device id the task runs on (optional)' },
      expected_behavior: { type: 'string' },
      verification_plan: { type: 'array', items: { type: 'string' } },
      task_id: { type: 'string', description: 'Existing task id when redefining (optional)' },
    },
    required: ['goal', 'acceptance_criteria'],
  },
  async execute(input, ctx) {
    if (ctx.taskContracts === 'deny') {
      return 'Error: task contracts are only created for /goal or an explicit task. Answer the user directly — do not create a task or retry this tool.';
    }
    const goal = String(input.goal ?? '').trim();
    if (!goal) return 'Error: task_define: goal is required.';
    const criteria = parseCriteria(input.acceptance_criteria);
    if (typeof criteria === 'string') return `Error: task_define: ${criteria}`;

    const now = Date.now();
    let taskId: string;
    let status: TaskContractStatus = 'active';
    let createdAt = now;
    if (input.task_id && typeof input.task_id === 'string') {
      taskId = input.task_id;
      const existing = (await listTaskRecords(ctx.workspaceDir)).find((t) => t.taskId === taskId);
      if (!existing)
        return `Error: task_define: task_id ${taskId} not found; omit it to create a new task.`;
      createdAt = existing.createdAt;
      if (existing.status === 'accepted' || existing.status === 'abandoned') {
        status = existing.status;
      }
    } else {
      taskId = newTaskId();
    }

    const task: TaskContract = {
      taskId,
      goal,
      acceptanceCriteria: criteria,
      status,
      createdAt,
      updatedAt: now,
      ...(stringList(input.constraints) ? { constraints: stringList(input.constraints) } : {}),
      ...(input.target_device ? { targetDeviceId: String(input.target_device) } : {}),
      ...(stringList(input.verification_plan)
        ? { verificationPlan: stringList(input.verification_plan) }
        : {}),
      ...(input.expected_behavior ? { expectedBehavior: String(input.expected_behavior) } : {}),
    };
    await appendTaskRecord(ctx.workspaceDir, task);
    // Task OS: an agent-created task enters the unified state machine here —
    // without these events the whole robotics P0 path (task_define driven by
    // the agent, not the engine) would be invisible to the runtime/TUI.
    if (!(input.task_id && typeof input.task_id === 'string')) {
      await appendTaskEvent(ctx.workspaceDir, taskId, 'task_created', { goal: task.goal });
      await appendTaskEvent(ctx.workspaceDir, taskId, 'plan_ready', {
        detail: 'contract defined by agent',
      });
    }
    const rows = task.acceptanceCriteria.map(
      (c) => `  - ${c.metric} ${c.expected}${c.required === false ? ' (optional)' : ''}`
    );
    return (
      `Task contract ${task.taskId} (${task.status}):\n` +
      `goal: ${task.goal}\n` +
      (task.targetDeviceId ? `target device: ${task.targetDeviceId}\n` : '') +
      `acceptance criteria (${task.acceptanceCriteria.length}):\n${rows.join('\n')}\n` +
      `Record evidence with record_evidence (task_id="${task.taskId}") and gate completion with task_acceptance.`
    );
  },
};

export const taskAcceptanceTool: Tool = {
  name: 'task_acceptance',
  description:
    'Evaluate a task against its evidence. Missing evidence for a required metric fails. Latest evidence per metric wins. Omit task_id to use the latest contract. Re-run after every repair.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task contract id from task_define (default: the latest defined contract)',
      },
    },
  },
  async execute(input, ctx) {
    const tasks = await listTaskRecords(ctx.workspaceDir);
    if (tasks.length === 0) {
      return 'Error: task_acceptance: no task contracts in this workspace — define one with task_define first.';
    }
    const taskId = String(input.task_id ?? '').trim();
    const task = taskId
      ? tasks.find((t) => t.taskId === taskId)
      : tasks.reduce((latest, t) => (t.updatedAt >= latest.updatedAt ? t : latest));
    if (!task) {
      return `Error: task_acceptance: task ${taskId} not found — check task ids with the define output, or omit task_id to use the latest contract.`;
    }
    const result = await evaluateContractAcceptance(ctx.workspaceDir, task.taskId, ctx.abortSignal);
    if (!result) {
      return `Error: task_acceptance: task ${task.taskId} disappeared from the store.`;
    }
    await emitAcceptanceLifecycle(
      ctx.workspaceDir,
      task.taskId,
      result.verdict.verdict === 'pass',
      formatAcceptanceVerdict(result.verdict, result.task),
      'contract',
      result.verdict.verdict === 'pass' ? undefined : ctx.abortSignal
    );
    return formatAcceptanceVerdict(result.verdict, result.task);
  },
};

const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'skipped'] as const;

export const taskPlanUpdateTool: Tool = {
  name: 'task_plan_update',
  description:
    'Publish or update the plan of a task (3-8 concrete steps) for the unified task runtime. Each step: {step_id, title, status?, detail?} with status pending|in_progress|done|failed|skipped. Send the FULL step list every call (latest wins). Use during planning, and mark steps done/failed as execution progresses — this is what the user sees as progress.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id from task_define' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step_id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['step_id', 'title'],
        },
      },
    },
    required: ['task_id', 'steps'],
  },
  async execute(input, ctx) {
    const taskId = String(input.task_id ?? '').trim();
    if (!taskId) return 'Error: task_plan_update: task_id is required.';
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      return 'Error: task_plan_update: steps must be a non-empty array.';
    }
    const known = await listTaskRecords(ctx.workspaceDir);
    if (!known.some((t) => t.taskId === taskId)) {
      return `Error: task_plan_update: unknown task_id ${taskId}.`;
    }
    const steps: TaskPlanStep[] = [];
    for (const raw of input.steps) {
      if (typeof raw !== 'object' || raw === null) {
        return 'Error: task_plan_update: each step must be an object.';
      }
      const candidate = raw as Record<string, unknown>;
      if (typeof candidate.step_id !== 'string' || !candidate.step_id.trim()) {
        return 'Error: task_plan_update: each step needs a step_id.';
      }
      if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
        return `Error: task_plan_update: step ${candidate.step_id} needs a title.`;
      }
      const status = candidate.status === undefined ? 'pending' : String(candidate.status);
      if (!(PLAN_STEP_STATUSES as readonly string[]).includes(status)) {
        return `Error: task_plan_update: step ${candidate.step_id} status "${status}" invalid (use ${PLAN_STEP_STATUSES.join('|')}).`;
      }
      steps.push({
        stepId: candidate.step_id.trim(),
        title: candidate.title.trim(),
        status: status as TaskPlanStep['status'],
        ...(typeof candidate.detail === 'string' && candidate.detail.trim()
          ? { detail: candidate.detail.trim() }
          : {}),
      });
    }
    const snapshot = await getTaskStateSnapshot(ctx.workspaceDir, taskId);
    if (snapshot && isTerminalTaskPhase(snapshot.phase)) {
      return `Error: task_plan_update: task ${taskId} is ${snapshot.phase}; plans are frozen on settled tasks.`;
    }
    await tryAppendTaskEvent(ctx.workspaceDir, taskId, 'plan_step_updated', { steps });
    const marks = steps.map(
      (s) =>
        `  [${
          s.status === 'done'
            ? 'x]'
            : s.status === 'in_progress'
              ? '>]'
              : s.status === 'failed'
                ? '!]'
                : ' ]'
        } ${s.title}`
    );
    return `Plan updated for ${taskId} (${steps.length} steps):\n${marks.join('\n')}`;
  },
};

export const recordFailureTool: Tool = {
  name: 'record_failure',
  description:
    'Record a failure (symptom, stage, later diagnosis and root cause). Pass failure_id to update the same row or mark it resolved.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id the failure belongs to' },
      symptom: {
        type: 'string',
        description:
          'What was observed going wrong, e.g. "camera_fps expected >=30, observed 17.2"',
      },
      stage: {
        type: 'string',
        description: 'Where it surfaced: executing|verifying|diagnosing|repairing|reverifying',
      },
      diagnosis: { type: 'string', description: 'Your analysis of why it failed' },
      root_cause: { type: 'string', description: 'The identified root cause' },
      evidence_ids: { type: 'array', items: { type: 'string' } },
      failure_id: { type: 'string', description: 'Existing failure id when updating a failure' },
      resolved: { type: 'boolean', description: 'Mark the failure resolved (default false)' },
    },
    required: ['task_id', 'symptom'],
  },
  async execute(input, ctx) {
    const taskId = String(input.task_id ?? '').trim();
    const symptom = String(input.symptom ?? '').trim();
    if (!taskId || !symptom) return 'Error: record_failure: task_id and symptom are required.';
    const known = await listTaskRecords(ctx.workspaceDir);
    if (!known.some((t) => t.taskId === taskId)) {
      return `Error: record_failure: unknown task_id ${taskId}.`;
    }
    const snapshot = await getTaskStateSnapshot(ctx.workspaceDir, taskId);
    const stage = (
      typeof input.stage === 'string' && input.stage.trim()
        ? input.stage.trim()
        : (snapshot?.phase ?? 'executing')
    ) as 'executing';
    // M12: idempotent per verification attempt — a repeated record_failure for
    // the same attempt updates the existing record instead of stacking clones.
    const existing = (await listFailures(ctx.workspaceDir, taskId)).find(
      (failure) => failure.attempt === (snapshot?.attempt ?? 1) && !failure.resolved
    );
    const failure = await recordFailure(ctx.workspaceDir, {
      taskId,
      stage,
      symptom,
      attempt: snapshot?.attempt ?? 1,
      resolved: input.resolved === true,
      ...(input.diagnosis ? { diagnosis: String(input.diagnosis) } : {}),
      ...(input.root_cause ? { rootCause: String(input.root_cause) } : {}),
      ...(Array.isArray(input.evidence_ids) ? { evidenceIds: input.evidence_ids.map(String) } : {}),
      ...(input.failure_id ? { failureId: String(input.failure_id) } : {}),
      ...(existing && !input.failure_id ? { failureId: existing.failureId } : {}),
    });
    await tryAppendTaskEvent(ctx.workspaceDir, taskId, 'diagnosis_recorded', {
      detail: symptom.slice(0, 200),
    });
    return `Failure ${failure.failureId} recorded for ${taskId} (stage ${stage}, attempt ${failure.attempt}).${
      input.root_cause ? ' Root cause captured.' : ''
    }Apply the fix, then record_repair.`;
  },
};

export const recordRepairTool: Tool = {
  name: 'record_repair',
  description:
    'Record the repair for a failure: what you changed, which files, whether a redeploy is needed/done. Pairs with record_failure — together they form the failure→diagnosis→repair trail the user reads.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id the repair belongs to' },
      action: { type: 'string', description: 'What was changed to fix the failure' },
      failure_id: { type: 'string', description: 'Failure id from record_failure (optional)' },
      changed_files: { type: 'array', items: { type: 'string' } },
      redeployed: { type: 'boolean', description: 'Whether the fix was redeployed to the device' },
    },
    required: ['task_id', 'action'],
  },
  async execute(input, ctx) {
    const taskId = String(input.task_id ?? '').trim();
    const action = String(input.action ?? '').trim();
    if (!taskId || !action) return 'Error: record_repair: task_id and action are required.';
    const known = await listTaskRecords(ctx.workspaceDir);
    if (!known.some((t) => t.taskId === taskId)) {
      return `Error: record_repair: unknown task_id ${taskId}.`;
    }
    const repair = await recordRepair(ctx.workspaceDir, {
      taskId,
      action,
      ...(input.failure_id ? { failureId: String(input.failure_id) } : {}),
      ...(Array.isArray(input.changed_files)
        ? { changedFiles: input.changed_files.map(String) }
        : {}),
      ...(input.redeployed === true ? { redeployed: true } : {}),
    });
    // Repair moves the lifecycle (diagnosing→repairing; no-op elsewhere).
    await tryAppendTaskEvent(ctx.workspaceDir, taskId, 'repair_applied', {
      detail: action.slice(0, 200),
    });
    return `Repair ${repair.repairId} recorded for ${taskId}: ${action}. Re-measure and record fresh evidence, then re-run task_acceptance.`;
  },
};

export const taskTools: Tool[] = [
  taskDefineTool,
  taskAcceptanceTool,
  taskPlanUpdateTool,
  recordFailureTool,
  recordRepairTool,
];
