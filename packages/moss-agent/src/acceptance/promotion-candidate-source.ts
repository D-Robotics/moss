import type { TerminalVerdictLog } from './terminal-verdict-log.js';
import { aggregatePromotionProofBySkill } from './terminal-verdict-log.js';
import type { ObservationStats } from '../memory/observation-aggregator.js';
import type { PromotionCandidate, PromotionCandidateSource } from './promotion-coordinator.js';
import type { CodingCompletionGateRequest } from '../cli/coding-completion-gate.js';
import { memoryWarn } from '../memory/logger.js';

export interface TerminalCandidateSourceDeps {
  terminalVerdictLog: TerminalVerdictLog;
  /** 统计置信度门槛(D6 ①)。默认 minProofCount=10。 */
  minProofCount?: number;
}

/**
 * 从终局硬信号统计触发升层候选(T3.4 closure)。
 *
 * 读 terminal-verdict log,按 skill 聚合任务级终态(pass/fail)。某 skill 的
 * 终态 proofCount(pass+fail decided)≥ minProofCount → 产一个候选。这是
 * **系统统计触发**(非模型自报),统计源是 Plan.terminalAccept 产物级硬信号,
 * 不是验证器 contractSkill pass(D5 可信根边界:验证器不得用自报成败作为
 * 升层依据)。
 *
 * 候选 id 稳定(term_${skill}),同证据窗口重评产生同 id(幂等,不刷屏)。
 *
 * 无终态信号(无 plan/terminalAccept 历史)→ 返 [],安全 no-op。
 */
export function createTerminalCandidateSource(
  deps: TerminalCandidateSourceDeps,
): PromotionCandidateSource<CodingCompletionGateRequest> {
  const minProofCount = deps.minProofCount ?? 10;
  return async (_completion: CodingCompletionGateRequest) => {
    let entries;
    try {
      entries = await deps.terminalVerdictLog.readAll();
    } catch (err) {
      memoryWarn('promotion candidate source read failed:', err);
      return [];
    }
    const statsBySkill = aggregatePromotionProofBySkill(entries);
    const candidates: PromotionCandidate[] = [];
    for (const stats of statsBySkill.values()) {
      if (stats.proofCount < minProofCount) continue;
      candidates.push({
        id: `term_${stats.skill}`,
        targetSkill: stats.skill,
        provenance: {
          layer: 'L2',
          kind: 'explicit-proposal',
          source: 'terminal-hard-signal',
          proposalRef: `terminal://${stats.skill}?proof=${stats.proofCount}&rate=${stats.successRate.toFixed(2)}`,
        },
      });
    }
    return candidates;
  };
}

/** 给 statsSource 用的:从 terminal log 取某 skill 的统计(terminal-only,非 contractSkill)。 */
export function createTerminalStatsSource(
  deps: TerminalCandidateSourceDeps,
): (candidate: PromotionCandidate) => Promise<ObservationStats | undefined> {
  return async (candidate: PromotionCandidate) => {
    let entries;
    try {
      entries = await deps.terminalVerdictLog.readAll();
    } catch (err) {
      memoryWarn('promotion stats source read failed:', err);
      return undefined;
    }
    const statsBySkill = aggregatePromotionProofBySkill(entries);
    return statsBySkill.get(candidate.targetSkill);
  };
}
