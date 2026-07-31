











export type PlanStatus =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'replanning'
  | 'failed'
  | 'cancelled';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed' | 'blocked';

export interface PlanStep {
  
  step: number;
  
  description: string;
  
  expectedTools?: string[];
  
  expectedOutput?: string;

  /**
   * 该步骤引用的验收契约 skill 名(D10 解 A:有 plan 时按 step 查契约)。
   * 如 ['rdk-device'] → hook 查 contractRegistry.findBySkill('rdk-device')
   *    跑其 postconditions 产 L1 判定。
   * 无则 hook 退回解 C(按 tool + input.command 反查契约)。
   */
  expectedAccept?: string[];

  dependsOn?: number[];
  
  estimatedTimeSec?: number;
  
  status: StepStatus;
  
  actualOutput?: string;
  
  actualTools?: string[];
  
  startedAt?: string;
  
  completedAt?: string;
  
  error?: string;
}

export interface Plan {
  
  id: string;
  
  goal: string;
  
  status: PlanStatus;
  
  steps: PlanStep[];
  
  rationale?: string;
  
  preconditions?: string[];
  
  successCriteria?: string[];

  /**
   * 结构化终态验收谓词(P0 任务级终态判定器用)。successCriteria 是人读自然语言,
   * terminalAccept 是可机器判定的白名单谓词(file_exist/stdout_matches/exit_code_zero),
   * 验任务最终产物(代码/配置/文档是否满足)。终态判定器跑这些产任务级 verdict
   * (硬信号:产物文件内容,非模型文本,符合 D1),喂给 T3.3 终局审计。无则终态 unknown。
   */
  terminalAccept?: import('../acceptance/types.js').AcceptSpec[];

  createdAt: string;
  
  updatedAt: string;
  
  currentStep?: number;
  
  replanCount?: number;
  
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
  
  maxReplans?: number;
  
  requireApproval?: boolean;
  
  autoApproveSimple?: boolean;
  
  maxExecutionTimeMs?: number;
}









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

  


  reviewPlan(planId: string): PlanReviewResult {
    const plan = this.plans.get(planId);
    if (!plan) {
      return { approved: false, issues: ['Plan not found'], suggestions: [] };
    }

    const issues: string[] = [];
    const suggestions: string[] = [];

    
    if (!plan.steps || plan.steps.length === 0) {
      issues.push('Plan has no steps');
    }

    if (!plan.goal || plan.goal.trim().length === 0) {
      issues.push('Plan has no goal');
    }

    
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

    
    if (this.hasCircularDependency(plan.steps)) {
      issues.push('Plan has circular dependencies');
    }

    
    const isSimple =
      !this.config.requireApproval ||
      (this.config.autoApproveSimple &&
        plan.steps.length <= 3 &&
        plan.steps.every(
          (s) =>
            !s.expectedTools ||
            s.expectedTools.every(
              (t) => !['exec', 'write_file', 'edit_file', 'device_exec'].includes(t)
            )
        ));

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

  


  approvePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status === 'executing' || plan.status === 'completed') return false;

    plan.status = 'approved';
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  


  startExecution(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'approved') return false;

    plan.status = 'executing';
    plan.currentStep = 1;
    plan.updatedAt = new Date().toISOString();

    
    if (plan.steps.length > 0) {
      plan.steps[0].status = 'in_progress';
      plan.steps[0].startedAt = new Date().toISOString();
    }

    this.activePlanId = planId;
    return true;
  }

  


  completeStep(
    planId: string,
    stepNumber: number,
    actualOutput?: string,
    actualTools?: string[]
  ): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'executing') return false;

    const step = plan.steps.find((s) => s.step === stepNumber);
    if (!step || step.status !== 'in_progress') return false;

    step.status = 'completed';
    step.actualOutput = actualOutput;
    step.actualTools = actualTools;
    step.completedAt = new Date().toISOString();

    
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

  


  skipStep(planId: string, stepNumber: number, reason: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'executing') return false;

    const step = plan.steps.find((s) => s.step === stepNumber);
    if (!step) return false;

    step.status = 'skipped';
    step.actualOutput = `Skipped: ${reason}`;
    step.completedAt = new Date().toISOString();

    
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

  


  requestReplan(
    planId: string,
    _reason: string,
    revisedSteps?: Omit<PlanStep, 'status'>[]
  ): Plan | null {
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

  


  getActivePlan(): Plan | null {
    return this.activePlanId ? (this.plans.get(this.activePlanId) ?? null) : null;
  }

  


  getPlan(planId: string): Plan | null {
    return this.plans.get(planId) ?? null;
  }

  


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
    for (let i = 0; i < plan.steps.length; i++) {
      if (i > 0 && i % 5 === 0) {
        lines.push(''); // Add spacing every 5 steps
      }

      const step = plan.steps[i];
      const statusIcon = {
        pending: '○',
        in_progress: '▶',
        completed: '✓',
        skipped: '⏭',
        failed: '✗',
        blocked: '🚫',
      }[step.status];

      let statusLine = `${statusIcon} Step ${step.step}: ${step.description} [${step.status}]`;

      // Add blocked dependency info if applicable
      if (step.status === 'blocked' && step.dependsOn && step.dependsOn.length > 0) {
        statusLine += ` — blocked by step(s): ${step.dependsOn.join(', ')}`;
      }

      lines.push(statusLine);
      if (step.expectedTools && step.expectedTools.length > 0) {
        lines.push(`   Tools: ${step.expectedTools.join(', ')}`);
      }
      if (step.expectedOutput) {
        lines.push(`   Expected: ${step.expectedOutput}`);
      }
      if (step.actualOutput) {
        lines.push(`   Actual: ${step.actualOutput}`);
        if (step.expectedOutput && step.actualOutput !== step.expectedOutput) {
          lines.push(`   ↑ Compare with Expected above`);
        }
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
