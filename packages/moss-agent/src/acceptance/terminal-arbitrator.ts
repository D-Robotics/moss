import type { ExperienceEntry } from '../memory/experience-log.js';

/**
 * 终局跨信号仲裁器(T3.3)— 任务终局时校验判据本身有效性。
 *
 * 职责不是判单次成败,而是【校验判据是否失效】:抓"单步全过但任务失败"的系统性误判。
 * 闭环里唯一非循环验证层级(机器人场景独有):对比"全流程单步 verdict"(层1/层2 契约判)
 *  vs"终态硬信号"(任务级,独立信号),发现系统性偏差。
 *
 * 两级:
 *  (1) 单次任务级:单步全 pass 但终态 fail → auditFailed(判据失效,该步契约/谓词标待复核)
 *  (2) 统计演化级:长期单步通过率 vs 终局成功率差值超阈 → driftDetected(触发契约重评)
 *
 * 见 docs/self-evolution-loop.md §5.3 / D5 / D7。
 */

export interface TaskTerminalInput {
  /** 本次任务的全流程 Experience 条目(按时间序)。 */
  experiences: ExperienceEntry[];
  /** 终态硬信号判定的任务级成败(独立信号,不来自单步 verdict)。 */
  terminalVerdict: 'pass' | 'fail' | 'unknown';
  /** 终态失败时的原因(诊断用)。 */
  terminalReason?: string;
}

export interface TerminalArbitrationResult {
  /** 单步判据是否失效(单步全 pass 但终态 fail)。 */
  auditFailed: boolean;
  /** 失效的契约 skill(若有,auditFailed=true 时填,定位哪步判据失效)。 */
  suspectSkills: string[];
  reason: string;
  /** 统计级漂移(单步通过率 vs 终局成功率差,用于长期漂移校准,本切片单次计算)。 */
  singleStepPassRate: number;
  driftFromTerminal: number; // singleStepPassRate - terminalPassIndicator
}

/**
 * 终局审计:校验单步判据是否与终态硬信号一致。
 * auditFailed = 单步全 pass 但终态 fail(判据失效 — 谓词说成功,任务实际失败)。
 */
export function auditTerminal(input: TaskTerminalInput): TerminalArbitrationResult {
  const { experiences, terminalVerdict, terminalReason } = input;

  // 收集有契约判定的单步 verdict(L1/L2 有 contractSkill 的)
  const contractSteps = experiences.filter((e) => e.diagnostics?.contractSkill);
  const allPass = contractSteps.length > 0 && contractSteps.every((e) => e.verdict === 'pass');
  const singleStepPassRate = contractSteps.length > 0
    ? contractSteps.filter((e) => e.verdict === 'pass').length / contractSteps.length
    : 1; // 无契约步骤不计入

  // 终态指示:pass=1, fail=0, unknown=0.5(未判定)
  const terminalIndicator = terminalVerdict === 'pass' ? 1 : terminalVerdict === 'unknown' ? 0.5 : 0;

  // (1) 单次任务级:单步全 pass 但终态 fail → 判据失效
  const auditFailed = allPass && terminalVerdict === 'fail';
  const suspectSkills = auditFailed
    ? [...new Set(contractSteps.map((e) => String(e.diagnostics?.contractSkill)))]
    : [];

  let reason: string;
  if (auditFailed) {
    reason = `判据失效:单步全 pass 但终态 fail(${terminalReason ?? 'no reason'})— 契约/谓词需要复核`;
  } else if (terminalVerdict === 'fail' && !allPass) {
    reason = '正常失败:单步有 fail 且终态 fail(单步判据与终态一致,非判据失效)';
  } else if (terminalVerdict === 'pass') {
    reason = '终态 pass,无判据失效';
  } else {
    reason = '终态 unknown,无法判定判据失效';
  }

  return {
    auditFailed,
    suspectSkills,
    reason,
    singleStepPassRate,
    driftFromTerminal: singleStepPassRate - terminalIndicator,
  };
}

export interface DriftCheckInput {
  /** 该 skill 的历史单步通过率(来自 Observation 聚合)。 */
  singleStepPassRate: number;
  /** 该 skill 的历史终局成功率(独立统计)。 */
  terminalSuccessRate: number;
  /** 漂移阈值(差值超此 → driftDetected,触发契约重评)。默认 0.2。 */
  driftThreshold?: number;
}

export interface DriftCheckResult {
  driftDetected: boolean;
  delta: number; // singleStepPassRate - terminalSuccessRate
  reason: string;
}

/**
 * 统计级漂移校准:单步通过率与终局成功率差值超阈 → 触发契约阈值/参数重评。
 * 解决硬信号漂移/传感器磨损(R3):长期两信号不一致 → 判据需校准。
 */
export function checkDrift(input: DriftCheckInput): DriftCheckResult {
  const { singleStepPassRate, terminalSuccessRate, driftThreshold = 0.2 } = input;
  const delta = singleStepPassRate - terminalSuccessRate;
  const driftDetected = Math.abs(delta) > driftThreshold;
  return {
    driftDetected,
    delta,
    reason: driftDetected
      ? `漂移检测:单步通过率 ${singleStepPassRate.toFixed(2)} 与终局成功率 ${terminalSuccessRate.toFixed(2)} 差 ${delta.toFixed(2)} 超阈 ${driftThreshold} → 触发契约重评`
      : `无漂移:差 ${delta.toFixed(2)} 在阈 ${driftThreshold} 内`,
  };
}
