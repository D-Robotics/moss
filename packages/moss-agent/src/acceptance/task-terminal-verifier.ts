import type { Plan } from '../plan-execute/plan-execute-controller.js';
import type { AcceptSpec } from './types.js';
import type { ExperienceEntry } from '../memory/experience-log.js';
import type { DeviceReadonlyExecutor } from '../core/tools/device-readonly-executor.js';
import type { TerminalExecutionEvidence } from '../cli/coding-completion-gate.js';
import { evaluatePostconditions, evaluatePredicate } from './predicate-evaluator.js';

/**
 * 任务级终态判定器(P0 最小可行版)— 读最终产物判任务成败。
 *
 * 这是闭环最后一块拼图:T3.3 终局审计需要"终态硬信号"(独立于单步 verdict)。
 * P0 从"产物级终态"切入(不依赖硬件传感器):跑 Plan.terminalAccept 谓词
 * (file_exist/stdout_matches/exit_code_zero,白名单),验任务最终产物。
 *
 * 关键:这是真硬信号不是造假。产物文件的内容是客观的(D1 要求"硬信号",
 * 产物文件内容就是,非模型文本)。P2 后加板子状态判定升级到"产物+物理级"。
 *
 * 无 plan / 无 terminalAccept → 终态 unknown(不造假,不强行判)。
 *
 * 见 docs/self-evolution-loop.md §5.3 / D1 / T3.3。
 */

export interface TaskTerminalInput {
  plan: Plan | null;
  /** 工作区(本地产物路径解析用)。 */
  workspaceDir: string;
  /** 设备只读执行器(设备路径产物验存在用)。无传 null。 */
  deviceExecutor: DeviceReadonlyExecutor | null;
  /** 任务最终回复文本(只供审计展示,不作为过程谓词证据)。 */
  finalResponse: string;
  /** 已验证的终端工具执行证据。 */
  executionEvidence?: TerminalExecutionEvidence;
  /** Allowlisted typed values derived by the host from this task/run. */
  bindingContext?: Record<string, string | number | boolean>;
}

export interface TaskTerminalVerdict {
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  /** 跑了几个终态谓词(0 = 无 terminalAccept)。 */
  checkedCount: number;
  /** 每谓词结果(审计用)。 */
  perPredicate?: Awaited<ReturnType<typeof evaluatePredicate>>[];
  safetyFailed?: boolean;
  safetyReasonCode?: string;
}

/**
 * 判任务终态:跑 Plan.terminalAccept 谓词。
 * - 有 terminalAccept 且全 pass → pass
 * - 任一 fail → fail
 * - 无 terminalAccept / 无 plan → unknown(不造假)
 * - 有 unknown(谓词无法判定,如几何谓词未实现)→ unknown(不武断 pass)
 */
export async function verifyTaskTerminal(input: TaskTerminalInput): Promise<TaskTerminalVerdict> {
  const { plan, workspaceDir, deviceExecutor, executionEvidence } = input;
  if (!plan) {
    return { verdict: 'unknown', reason: '无 plan,无终态验收标准(不造假)', checkedCount: 0 };
  }
  const terminalAccept = plan.terminalAccept;
  if (!terminalAccept || terminalAccept.length === 0) {
    return { verdict: 'unknown', reason: 'plan 无 terminalAccept(只有人读 successCriteria)', checkedCount: 0 };
  }

  const requiresExecutionEvidence = terminalAccept.some(
    (spec) => spec.name === 'stdout_matches' || spec.name === 'exit_code_zero',
  );
  if (requiresExecutionEvidence && !executionEvidence) {
    return {
      verdict: 'unknown',
      reason: 'terminal execution evidence unavailable',
      checkedCount: terminalAccept.length,
    };
  }

  // 跑终态谓词(复用 evaluatePostconditions 的 AND 语义)
  const result = await evaluatePostconditions(terminalAccept, {
    result: executionEvidence?.stdout ?? '',
    reportedIsError: executionEvidence?.exitCode !== undefined
      ? executionEvidence.exitCode !== 0
      : false,
    exitCode: executionEvidence?.exitCode,
    input: {},
    workspaceDir,
    deviceExecutor,
    bindings: input.bindingContext,
  });
  const safetyFailureIndex = terminalAccept.findIndex((spec, index) => (
    spec.safetyCritical === true && result.perPredicate?.[index]?.verdict === 'fail'
  ));
  return {
    verdict: result.verdict,
    reason: result.reasonCode ?? 'terminal checked',
    checkedCount: terminalAccept.length,
    perPredicate: result.perPredicate,
    ...(safetyFailureIndex >= 0 ? {
      safetyFailed: true,
      safetyReasonCode: `safety_predicate_failed:${terminalAccept[safetyFailureIndex]!.name}`,
    } : {}),
  };
}

/**
 * 终态 + 单步审计的组合(T3.3 终局审计的接线入口)+ 漂移校准(T3.3 待项接线)。
 * 给 completionGate 用:读 plan + experiences,产 auditTerminal 结果 + driftChecks。
 *
 * 漂移校准:对 suspectSkills(或单步涉及的契约 skill),若 terminal-verdict log 有
 * 足够历史样本(proofCount ≥ minDriftSamples),跑 checkDrift(单步通过率 vs 终局
 * 成功率)。冷启动样本不足 → 跳过(不误报)。无 log / 无样本 → no-op(行为同前)。
 * 漂移是观察性,绝不单独阻断 completion(auditFailed 才阻断)。
 *
 * @param plan 当前 plan(含 terminalAccept)
 * @param experiences 本次任务全流程 Experience 条目
 * @param workspaceDir / deviceExecutor / finalResponse 终态判定输入
 * @param terminalVerdictLog 终局信号日志(可选,供漂移校准取历史终局成功率)
 * @param minDriftSamples 漂移校准最小样本(默认 10,冷启动 guard)
 * @returns auditTerminal 结果(auditFailed = 单步全 pass 但终态 fail)+ driftChecks
 */
export async function arbitrateTaskTerminal(input: TaskTerminalInput & {
  experiences: ExperienceEntry[];
  terminalVerdictLog?: {
    readAll(): Promise<ReadonlyArray<{ skill: string; verdict: 'pass' | 'fail' | 'unknown' }>>;
  };
  minDriftSamples?: number;
}) {
  const terminal = await verifyTaskTerminal(input);
  // 终态是硬信号;若终态 unknown,审计无法判定判据失效(需终态明确 fail 才审计)
  // 引用 terminal-arbitrator 的 auditTerminal + checkDrift
  const { auditTerminal, checkDrift } = await import('./terminal-arbitrator.js');
  const { aggregateTerminalBySkill } = await import('./terminal-verdict-log.js');
  const arbitration = auditTerminal({
    experiences: input.experiences,
    terminalVerdict: terminal.verdict,
    terminalReason: terminal.reason,
  });

  // 漂移校准接线:对涉及的契约 skill 跑 checkDrift(若有 log 且样本足)
  const driftChecks: Array<{ skill: string; driftDetected: boolean; delta: number; reason: string }> = [];
  if (input.terminalVerdictLog) {
    const skills = new Set<string>(arbitration.suspectSkills);
    // 也对单步 Experience 里涉及的契约 skill 跑(漂移不只看 suspect)
    for (const e of input.experiences) {
      const sk = e.contractSkill ?? e.diagnostics?.contractSkill;
      if (typeof sk === 'string') skills.add(sk);
    }
    if (skills.size > 0) {
      const minSamples = input.minDriftSamples ?? 10;
      const entries = await input.terminalVerdictLog.readAll();
      const terminalStatsBySkill = aggregateTerminalBySkill(entries as Parameters<typeof aggregateTerminalBySkill>[0]);
      // 单步通过率按 skill 从 experiences 算
      const stepBySkill = new Map<string, { pass: number; decided: number }>();
      for (const e of input.experiences) {
        const sk = e.contractSkill ?? e.diagnostics?.contractSkill;
        if (typeof sk !== 'string') continue;
        let s = stepBySkill.get(sk);
        if (!s) { s = { pass: 0, decided: 0 }; stepBySkill.set(sk, s); }
        if (e.verdict === 'pass' || e.verdict === 'fail') {
          s.decided += 1;
          if (e.verdict === 'pass') s.pass += 1;
        }
      }
      for (const skill of skills) {
        const ts = terminalStatsBySkill.get(skill);
        if (!ts || ts.proofCount < minSamples) continue; // 冷启动 guard
        const step = stepBySkill.get(skill);
        if (!step || step.decided === 0) continue;
        const singleStepPassRate = step.pass / step.decided;
        const terminalSuccessRate = ts.successRate;
        const dc = checkDrift({ singleStepPassRate, terminalSuccessRate });
        driftChecks.push({ skill, driftDetected: dc.driftDetected, delta: dc.delta, reason: dc.reason });
      }
    }
  }

  return {
    terminal,
    arbitration: {
      ...arbitration,
      driftChecks,
    },
  };
}

// 显式导出 AcceptSpec 类型供 plan 引用(避免循环 import 问题)
export type { AcceptSpec };
