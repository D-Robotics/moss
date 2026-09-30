import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AcceptanceCriterion,
  AcceptanceVerdict,
  TaskContract,
  TaskContractStatus,
} from '../contracts/task.js';
import { evaluateAcceptance, formatAcceptanceVerdict } from '../contracts/task.js';
import type { Tool } from '../core/tools/tool-types.js';
import { listEvidenceRecords } from './evidence-tools.js';

/**
 * Task contract tools (robotics closed loop P0-1/P0-2): define the task as a
 * machine-checkable object, then gate completion on acceptance evaluated
 * against recorded evidence. task_acceptance is the "did we really finish"
 * answer — the agent never self-certifies.
 */

function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function taskStorePath(workspaceDir: string): Promise<string> {
  const dir = path.join(workspaceDir, '.moss');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'tasks.jsonl');
}

export async function appendTaskRecord(workspaceDir: string, task: TaskContract): Promise<void> {
  const file = await taskStorePath(workspaceDir);
  await fs.appendFile(file, `${JSON.stringify(task)}\n`, 'utf8');
}

export async function listTaskRecords(workspaceDir: string, limit = 50): Promise<TaskContract[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, '.moss', 'tasks.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const parsed = lines.map((line) => JSON.parse(line) as TaskContract);
    // Latest version of each taskId wins (contracts are re-defined as they evolve).
    const byId = new Map(parsed.map((task) => [task.taskId, task]));
    return [...byId.values()].slice(-limit);
  } catch {
    return [];
  }
}

async function appendAcceptanceVerdict(
  workspaceDir: string,
  verdict: AcceptanceVerdict
): Promise<void> {
  const dir = path.join(workspaceDir, '.moss');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'acceptance.jsonl'), `${JSON.stringify(verdict)}\n`, 'utf8');
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
    'Define (or redefine) the current work as a structured task contract: goal, constraints, target device, expected behavior, and machine-checkable acceptance criteria. Do this BEFORE implementing a real task — acceptance criteria are what task_acceptance will hold the work accountable to (each criterion = an evidence metric + expectation, e.g. {metric: "camera_fps", expected: ">=30"}).\n' +
    'Redefining an existing task_id updates it in place.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The user-level goal in one or two sentences' },
      acceptance_criteria: {
        type: 'array',
        description:
          'What "done" means, checkable against evidence: [{metric, expected, required?, description?}]',
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
    'Evaluate a task contract against its recorded evidence and return the acceptance verdict. Required criteria with no matching evidence FAIL acceptance ("no evidence, no success"); the latest evidence per metric wins, so a repaired re-measurement supersedes an earlier failure. Run this before claiming a task is done — and re-run it after every repair.',
  metadata: { sideEffectClass: 'runtime_state', planMode: 'allow' },
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task contract id from task_define' },
    },
    required: ['task_id'],
  },
  async execute(input, ctx) {
    const taskId = String(input.task_id ?? '').trim();
    const task = (await listTaskRecords(ctx.workspaceDir)).find((t) => t.taskId === taskId);
    if (!task) {
      return `Error: task_acceptance: task ${taskId || '(none given)'} not found — define it with task_define first.`;
    }
    const evidence = await listEvidenceRecords(ctx.workspaceDir, 1000);
    const verdict = evaluateAcceptance(task, evidence);
    await appendAcceptanceVerdict(ctx.workspaceDir, verdict);

    if (verdict.verdict === 'pass' && task.status !== 'accepted') {
      const accepted: TaskContract = { ...task, status: 'accepted', updatedAt: Date.now() };
      await appendTaskRecord(ctx.workspaceDir, accepted);
    } else if (verdict.verdict === 'fail' && task.status === 'active') {
      const failed: TaskContract = { ...task, status: 'failed', updatedAt: Date.now() };
      await appendTaskRecord(ctx.workspaceDir, failed);
    }

    return formatAcceptanceVerdict(verdict, task);
  },
};

export const taskTools: Tool[] = [taskDefineTool, taskAcceptanceTool];
