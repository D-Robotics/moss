import type { Plan } from '../plan-execute/plan-execute-controller.js';
import type { AcceptSpec } from './types.js';
import type { ExperienceEntry } from '../memory/experience-log.js';
import type { DeviceReadonlyExecutor } from '../core/tools/device-readonly-executor.js';
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
  /** 任务最终回复文本(stdout_matches 终态谓词可匹配它,如"已部署到 X")。 */
  finalResponse: string;
}

export interface TaskTerminalVerdict {
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  /** 跑了几个终态谓词(0 = 无 terminalAccept)。 */
  checkedCount: number;
  /** 每谓词结果(审计用)。 */
  perPredicate?: Awaited<ReturnType<typeof evaluatePredicate>>[];
}

/**
 * 判任务终态:跑 Plan.terminalAccept 谓词。
 * - 有 terminalAccept 且全 pass → pass
 * - 任一 fail → fail
 * - 无 terminalAccept / 无 plan → unknown(不造假)
 * - 有 unknown(谓词无法判定,如几何谓词未实现)→ unknown(不武断 pass)
 */
export async function verifyTaskTerminal(input: TaskTerminalInput): Promise<TaskTerminalVerdict> {
  const { plan, workspaceDir, deviceExecutor, finalResponse } = input;
  if (!plan) {
    return { verdict: 'unknown', reason: '无 plan,无终态验收标准(不造假)', checkedCount: 0 };
  }
  const terminalAccept = plan.terminalAccept;
  if (!terminalAccept || terminalAccept.length === 0) {
    return { verdict: 'unknown', reason: 'plan 无 terminalAccept(只有人读 successCriteria)', checkedCount: 0 };
  }

  // 跑终态谓词(复用 evaluatePostconditions 的 AND 语义)
  const result = await evaluatePostconditions(terminalAccept, {
    result: finalResponse, // stdout_matches 可匹配最终回复
    reportedIsError: false,
    input: {},
    workspaceDir,
    deviceExecutor,
  });
  return {
    verdict: result.verdict,
    reason: result.reasonCode ?? 'terminal checked',
    checkedCount: terminalAccept.length,
    perPredicate: result.perPredicate,
  };
}

/**
 * 终态 + 单步审计的组合(T3.3 终局审计的接线入口)。
 * 给 completionGate 用:读 plan + experiences,产 auditTerminal 结果。
 *
 * @param plan 当前 plan(含 terminalAccept)
 * @param experiences 本次任务全流程 Experience 条目
 * @param workspaceDir / deviceExecutor / finalResponse 终态判定输入
 * @returns auditTerminal 结果(auditFailed = 单步全 pass 但终态 fail)
 */
export async function arbitrateTaskTerminal(input: TaskTerminalInput & {
  experiences: ExperienceEntry[];
}) {
  const terminal = await verifyTaskTerminal(input);
  // 终态是硬信号;若终态 unknown,审计无法判定判据失效(需终态明确 fail 才审计)
  // 引用 terminal-arbitrator 的 auditTerminal
  const { auditTerminal } = await import('./terminal-arbitrator.js');
  return {
    terminal,
    arbitration: auditTerminal({
      experiences: input.experiences,
      terminalVerdict: terminal.verdict,
      terminalReason: terminal.reason,
    }),
  };
}

// 显式导出 AcceptSpec 类型供 plan 引用(避免循环 import 问题)
export type { AcceptSpec };
