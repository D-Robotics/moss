/**
 * Plan-Execute Controller — manages the lifecycle of a plan through execution.
 *
 * The controller orchestrates:
 * - Plan creation and validation
 * - Step-by-step execution tracking
 * - Plan-vs-actual comparison
 * - Replanning when execution deviates
 *
 * @public
 */

export type PlanStatus = 'draft' | 'reviewing' | 'approved' | 'executing' | 'completed' | 'replanning' | 'failed' | 'cancelled';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed' | 'blocked';

export interface PlanStep {
  /** Step number (1-based). */
  step: number;
  /** Human-readable description of what this step accomplishes. */
  description: string;
  /** Expected tools to be used in this step. */
  expectedTools?: string[];
  /** Expected output/result description. */
  expectedOutput?: string;
  /** Dependencies on other step numbers. */
  dependsOn?: number[];
  /** Maximum estimated time in seconds. */
  estimatedTimeSec?: number;
  /** Current status. */
  status: StepStatus;
  /** Actual output after execution. */
  actualOutput?: string;
  /** Tools actually used during execution. */
  actualTools?: string[];
  /** Start time of execution. */
  startedAt?: string;
  /** Completion time of execution. */
  completedAt?: string;
  /** Error message if step failed. */
  error?: string;
}

export interface Plan {
  /** Unique plan identifier. */
  id: string;
  /** Original task/goal description. */
  goal: string;
  /** Current plan status. */
  status: PlanStatus;
  /** Ordered list of steps. */
  steps: PlanStep[];
  /** Overall plan rationale/strategy. */
  rationale?: string;
  /** Preconditions that must be met before execution. */
  preconditions?: string[];
  /** Success criteria for the plan. */
  successCriteria?: string[];
  /** When the plan was created. */
  createdAt: string;
  /** When the plan was last updated. */
  updatedAt: string;
  /** Current step being executed (1-based). */
  currentStep?: number;
  /** Total number of replan iterations. */
  replanCount?: number;
  /** Version of the plan (incremented on replan). */
  version: number;
}

export interface ExecutionState {
  planId: string;
  currentStep: number;
  completedSteps: number;
  totalSteps: number;
  isExecuting: boolean;
  lastError?: string;
}

export interface PlanReviewResult {
  approved: boolean;
  issues: string[];
  suggestions: string[];
  revisedPlan?: Plan;
}

export interface PlanExecuteConfig {
  /** Maximum number of replan iterations (default 3). */
  maxReplans?: number;
  /** Whether to require user approval before execution (default true). */
  requireApproval?: boolean;
  /** Whether to auto-approve simple plans (no side effects, <=3 steps). */
  autoApproveSimple?: boolean;
  /** Maximum total execution time in ms. */
  maxExecutionTimeMs?: number;
}

/**
 * Plan-Execute Controller.
 *
 * Manages the lifecycle of a plan: creation, review, execution tracking,
 * and replanning when needed.
 *
 * @public
 */
export class PlanExecuteController {
  private config: Required<PlanExecuteConfig>;
  private plans: Map<string, Plan> = new Map();
  private activePlanId: string | null = null;

  constructor(config: PlanExecuteConfig = {}) {
    this.config = {
      maxReplans: config.maxReplans ?? 3,
      requireApproval: config.requireApproval ?? true,
      autoApproveSimple: config.autoApproveSimple ?? true,
      maxExecutionTimeMs: config.maxExecutionTimeMs ?? 300_000,
    };
  }

  /**
   * Create a new plan from a goal description.
   */
  createPlan(goal: string, steps: Omit<PlanStep, 'status'>[], rationale?: string): Plan {
    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const plan: Plan = {
      id,
      goal,
      status: 'draft',
      steps: steps.map((s, i) => ({
        ...s,
        step: i + 1,
        status: 'pending' as StepStatus,
      })),
      rationale,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    this.plans.set(id, plan);
    return plan;
  }

  /**
   * Review a plan and determine if it can be executed.
   */
  reviewPlan(planId: string): PlanReviewResult {
    const plan = this.plans.get(planId);
    if (!plan) {
      return { approved: false, issues: ['Plan not found'], suggestions: [] };
    }

    const issues: string[] = [];
    const suggestions: string[] = [];

    // Validate plan structure
    if (!plan.steps || plan.steps.length === 0) {
      issues.push('Plan has no steps');
    }

    if (!plan.goal || plan.goal.trim().length === 0) {
      issues.push('Plan has no goal');
    }

    // Check step dependencies
    const stepNumbers = new Set(plan.steps.map((s) => s.step));
    for (const step of plan.steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!stepNumbers.has(dep)) {
            issues.push(`Step ${step.step} depends on non-existent step ${dep}`);
          }
          if (dep >= step.step) {
            issues.push(`Step ${step.step} depends on future step ${dep}`);
          }
        }
      }
    }

    // Check for circular dependencies
    if (this.hasCircularDependency(plan.steps)) {
      issues.push('Plan has circular dependencies');
    }

    // Auto-approve simple plans
    const isSimple = !this.config.requireApproval ||
      (this.config.autoApproveSimple &&
        plan.steps.length <= 3 &&
        plan.steps.every((s) => !s.expectedTools || s.expectedTools.every((t) =>
          !['exec', 'write_file', 'edit_file', 'device_exec'].includes(t),
        )));

    if (isSimple && issues.length === 0) {
      plan.status = 'approved';
      plan.updatedAt = new Date().toISOString();
      return { approved: true, issues: [], suggestions };
    }

    if (issues.length === 0) {
      plan.status = 'reviewing';
      plan.updatedAt = new Date().toISOString();
      suggestions.push('Plan looks valid. Ready for approval.');
    }

    return {
      approved: issues.length === 0 && isSimple,
      issues,
      suggestions,
    };
  }

  /**
   * Approve a plan for execution.
   */
  approvePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status === 'executing' || plan.status === 'completed') return false;

    plan.status = 'approved';
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Start executing a plan.
   */
  startExecution(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'approved') return false;

    plan.status = 'executing';
    plan.currentStep = 1;
    plan.updatedAt = new Date().toISOString();

    // Mark first step as in_progress
    if (plan.steps.length > 0) {
      plan.steps[0].status = 'in_progress';
      plan.steps[0].startedAt = new Date().toISOString();
    }

    this.activePlanId = planId;
    return true;
  }

  /**
   * Mark a step as completed and move to the next step.
   */
  completeStep(planId: string, stepNumber: number, actualOutput?: string, actualTools?: string[]): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'executing') return false;

    const step = plan.steps.find((s) => s.step === stepNumber);
    if (!step || step.status !== 'in_progress') return false;

    step.status = 'completed';
    step.actualOutput = actualOutput;
    step.actualTools = actualTools;
    step.completedAt = new Date().toISOString();

    // Move to next step
    const nextStep = plan.steps.find((s) => s.step === stepNumber + 1);
    if (nextStep) {
      nextStep.status = 'in_progress';
      nextStep.startedAt = new Date().toISOString();
      plan.currentStep = nextStep.step;
    } else {
      // All steps completed
      plan.status = 'completed';
      plan.currentStep = undefined;
    }

    plan.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Mark a step as failed.
   */
  failStep(planId: string, stepNumber: number, error: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'executing') return false;

    const step = plan.steps.find((s) => s.step === stepNumber);
    if (!step) return false;

    step.status = 'failed';
    step.error = error;
    step.completedAt = new Date().toISOString();
    plan.updatedAt = new Date().toISOString();

    return true;
  }

  /**
   * Skip a step.
   */
  skipStep(planId: string, stepNumber: number, reason: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'executing') return false;

    const step = plan.steps.find((s) => s.step === stepNumber);
    if (!step) return false;

    step.status = 'skipped';
    step.actualOutput = `Skipped: ${reason}`;
    step.completedAt = new Date().toISOString();

    // Move to next step
    const nextStep = plan.steps.find((s) => s.step === stepNumber + 1);
    if (nextStep) {
      nextStep.status = 'in_progress';
      nextStep.startedAt = new Date().toISOString();
      plan.currentStep = nextStep.step;
    } else {
      plan.status = 'completed';
      plan.currentStep = undefined;
    }

    plan.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Request a replan due to execution deviation.
   */
  requestReplan(planId: string, _reason: string, revisedSteps?: Omit<PlanStep, 'status'>[]): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    if ((plan.replanCount ?? 0) >= this.config.maxReplans) {
      plan.status = 'failed';
      plan.updatedAt = new Date().toISOString();
      return null;
    }

    plan.status = 'replanning';
    plan.replanCount = (plan.replanCount ?? 0) + 1;

    if (revisedSteps) {
      // Create a new version with revised steps
      const completedSteps = plan.steps.filter((s) => s.status === 'completed');
      const newSteps: PlanStep[] = [
        ...completedSteps.map((s) => ({ ...s })),
        ...revisedSteps.map((s, i) => ({
          ...s,
          step: completedSteps.length + i + 1,
          status: 'pending' as StepStatus,
        })),
      ];

      plan.steps = newSteps;
      plan.version += 1;
    }

    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  /**
   * Cancel plan execution.
   */
  cancelPlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;

    plan.status = 'cancelled';
    plan.updatedAt = new Date().toISOString();
    if (this.activePlanId === planId) {
      this.activePlanId = null;
    }
    return true;
  }

  /**
   * Get current execution state.
   */
  getExecutionState(planId: string): ExecutionState | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    return {
      planId: plan.id,
      currentStep: plan.currentStep ?? 0,
      completedSteps: plan.steps.filter((s) => s.status === 'completed').length,
      totalSteps: plan.steps.length,
      isExecuting: plan.status === 'executing',
      lastError: plan.steps.find((s) => s.status === 'failed')?.error,
    };
  }

  /**
   * Get the active plan.
   */
  getActivePlan(): Plan | null {
    return this.activePlanId ? this.plans.get(this.activePlanId) ?? null : null;
  }

  /**
   * Get a plan by ID.
   */
  getPlan(planId: string): Plan | null {
    return this.plans.get(planId) ?? null;
  }

  /**
   * Format a plan as a human-readable string.
   */
  static formatPlan(plan: Plan): string {
    const lines: string[] = [];

    lines.push(`# Plan: ${plan.goal}`);
    lines.push(`ID: ${plan.id}`);
    lines.push(`Status: ${plan.status}`);
    lines.push(`Version: ${plan.version}`);
    lines.push(`Created: ${plan.createdAt}`);
    if (plan.rationale) {
      lines.push('');
      lines.push(`## Rationale`);
      lines.push(plan.rationale);
    }
    if (plan.preconditions && plan.preconditions.length > 0) {
      lines.push('');
      lines.push(`## Preconditions`);
      for (const p of plan.preconditions) {
        lines.push(`- ${p}`);
      }
    }
    if (plan.successCriteria && plan.successCriteria.length > 0) {
      lines.push('');
      lines.push(`## Success Criteria`);
      for (const c of plan.successCriteria) {
        lines.push(`- ${c}`);
      }
    }
    lines.push('');
    lines.push(`## Steps (${plan.steps.length})`);
    for (const step of plan.steps) {
      const statusIcon = {
        pending: '○',
        in_progress: '▶',
        completed: '✓',
        skipped: '⏭',
        failed: '✗',
        blocked: '🚫',
      }[step.status];

      lines.push(`${statusIcon} Step ${step.step}: ${step.description} [${step.status}]`);
      if (step.expectedTools && step.expectedTools.length > 0) {
        lines.push(`   Tools: ${step.expectedTools.join(', ')}`);
      }
      if (step.expectedOutput) {
        lines.push(`   Expected: ${step.expectedOutput}`);
      }
      if (step.actualOutput) {
        lines.push(`   Actual: ${step.actualOutput}`);
      }
      if (step.error) {
        lines.push(`   Error: ${step.error}`);
      }
      if (step.estimatedTimeSec) {
        lines.push(`   Est. time: ${step.estimatedTimeSec}s`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Check for circular dependencies in steps.
   */
  private hasCircularDependency(steps: PlanStep[]): boolean {
    const stepMap = new Map(steps.map((s) => [s.step, s]));
    const visited = new Set<number>();
    const inStack = new Set<number>();

    function dfs(stepNum: number): boolean {
      if (inStack.has(stepNum)) return true;
      if (visited.has(stepNum)) return false;

      visited.add(stepNum);
      inStack.add(stepNum);

      const step = stepMap.get(stepNum);
      if (step?.dependsOn) {
        for (const dep of step.dependsOn) {
          if (dfs(dep)) return true;
        }
      }

      inStack.delete(stepNum);
      return false;
    }

    for (const step of steps) {
      if (dfs(step.step)) return true;
    }

    return false;
  }
}
