/**
 * D5 declarative orchestration: a workflow plan is a JSON list of steps with
 * dependencies, executed as fresh headless sessions.
 *
 * Why not a JS sandbox: the owner unfroze "declarative/scripted orchestration"
 * but not arbitrary code execution. A plan can only say *what* to run and in
 * which order — it cannot call the agent API, read env, or import modules. That
 * keeps the feature reviewable, resumable and safely re-runnable.
 */
export interface WorkflowStep {
  /** Stable id inside the plan; also the state-file key. */
  id: string;
  /** Task text handed to a fresh headless session. */
  task: string;
  /** Step ids that must pass first. */
  dependsOn: string[];
  /** Coordination hints only, forwarded to the child prompt (not enforced). */
  writePaths: string[];
  /** Per-step cap; the child session enforces its own turn cap. */
  maxTurns?: number;
}

export interface WorkflowPlan {
  name: string;
  description?: string;
  /** Steps allowed to run at once; 1..4. */
  concurrency: number;
  steps: WorkflowStep[];
}

export interface WorkflowPlanIssue {
  /** Index in `steps`, or -1 for plan-level problems. */
  step: number;
  message: string;
}

export const WORKFLOW_MAX_STEPS = 50;
export const WORKFLOW_MAX_CONCURRENCY = 4;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface WorkflowPlanParse {
  plan?: WorkflowPlan;
  issues: WorkflowPlanIssue[];
}

/** Parse + validate a plan. Never throws; every problem is collected. */
export function parseWorkflowPlan(raw: unknown): WorkflowPlanParse {
  const issues: WorkflowPlanIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ step: -1, message: 'plan must be a JSON object' }] };
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!ID_RE.test(name)) {
    issues.push({ step: -1, message: 'name must be lowercase letters/digits/._- (max 64 chars)' });
  }
  const description =
    typeof record.description === 'string' ? record.description.trim() : undefined;
  const rawSteps = record.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { issues: [...issues, { step: -1, message: 'steps must be a non-empty array' }] };
  }
  if (rawSteps.length > WORKFLOW_MAX_STEPS) {
    issues.push({ step: -1, message: `at most ${String(WORKFLOW_MAX_STEPS)} steps` });
  }
  let concurrency = 2;
  if (record.concurrency !== undefined) {
    if (
      typeof record.concurrency !== 'number' ||
      !Number.isInteger(record.concurrency) ||
      record.concurrency < 1 ||
      record.concurrency > WORKFLOW_MAX_CONCURRENCY
    ) {
      issues.push({
        step: -1,
        message: `concurrency must be an integer 1..${String(WORKFLOW_MAX_CONCURRENCY)}`,
      });
    } else {
      concurrency = record.concurrency;
    }
  }
  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  rawSteps.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ step: index, message: 'step must be an object' });
      return;
    }
    const stepRecord = entry as Record<string, unknown>;
    const id = typeof stepRecord.id === 'string' ? stepRecord.id.trim() : '';
    if (!ID_RE.test(id)) {
      issues.push({ step: index, message: 'id must be lowercase letters/digits/._- (max 64)' });
    } else if (seen.has(id)) {
      issues.push({ step: index, message: `duplicate id "${id}"` });
    }
    seen.add(id);
    const task = typeof stepRecord.task === 'string' ? stepRecord.task.trim() : '';
    if (!task) issues.push({ step: index, message: 'task must be a non-empty string' });
    const dependsOn: string[] = [];
    if (stepRecord.dependsOn !== undefined) {
      if (
        !Array.isArray(stepRecord.dependsOn) ||
        stepRecord.dependsOn.some((dep) => typeof dep !== 'string')
      ) {
        issues.push({ step: index, message: 'dependsOn must be an array of step ids' });
      } else {
        dependsOn.push(...(stepRecord.dependsOn as string[]));
      }
    }
    const writePaths: string[] = [];
    if (stepRecord.writePaths !== undefined) {
      if (
        !Array.isArray(stepRecord.writePaths) ||
        stepRecord.writePaths.some((p) => typeof p !== 'string')
      ) {
        issues.push({ step: index, message: 'writePaths must be an array of paths' });
      } else {
        writePaths.push(...(stepRecord.writePaths as string[]));
      }
    }
    let maxTurns: number | undefined;
    if (stepRecord.maxTurns !== undefined) {
      if (
        typeof stepRecord.maxTurns !== 'number' ||
        !Number.isInteger(stepRecord.maxTurns) ||
        stepRecord.maxTurns < 1 ||
        stepRecord.maxTurns > 200
      ) {
        issues.push({ step: index, message: 'maxTurns must be an integer 1..200' });
      } else {
        maxTurns = stepRecord.maxTurns;
      }
    }
    steps.push({
      id,
      task,
      dependsOn,
      writePaths,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });
  });
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({ step: steps.indexOf(step), message: `unknown dependency "${dep}"` });
      }
    }
  }
  if (issues.length === 0 && hasCycle(steps)) {
    issues.push({ step: -1, message: 'dependency cycle detected' });
  }
  if (issues.length > 0) return { issues };
  return {
    plan: {
      name,
      ...(description ? { description } : {}),
      concurrency,
      steps,
    },
    issues: [],
  };
}

function hasCycle(steps: readonly WorkflowStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === 'done') return false;
    if (current === 'visiting') return true;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  return steps.some((step) => visit(step.id));
}

/**
 * Dependent-first execution waves: every step in a wave has all dependencies in
 * earlier waves. `skip` (resume) filters out steps that already passed, but a
 * skipped step still satisfies the dependencies of later steps.
 */
export function planWaves(
  plan: WorkflowPlan,
  skip: ReadonlySet<string> = new Set()
): WorkflowStep[][] {
  const done = new Set(skip);
  const waves: WorkflowStep[][] = [];
  const remaining = plan.steps.filter((step) => !done.has(step.id));
  let guard = 0;
  while (remaining.length > 0) {
    if (guard++ > WORKFLOW_MAX_STEPS + 1) break;
    const wave = remaining.filter((step) => step.dependsOn.every((dep) => done.has(dep)));
    if (wave.length === 0) break; // validation prevents this
    for (const step of wave) {
      done.add(step.id);
      remaining.splice(remaining.indexOf(step), 1);
    }
    waves.push(wave);
  }
  for (const wave of waves) {
    wave.sort((a, b) => plan.steps.indexOf(a) - plan.steps.indexOf(b));
  }
  return waves;
}
