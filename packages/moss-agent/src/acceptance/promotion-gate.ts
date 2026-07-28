import type { ObservationStats } from '../memory/observation-aggregator.js';

/**
 * 契约升层闸(T3.4)— D6 双门槛:层2 谓词 → 层1 正式契约。
 *
 * Reflect 只能算"谓词与历史成败相关性高"(统计置信度),不能验"测量本身有效"
 * (测量有效性是循环论证,必须跨信号)。双门槛都过才升层:
 *   ① 统计置信度门槛:proofCount ≥ 阈值(冷启动保护)+ successRate 达标
 *   ② 测量有效性门槛:crossSignalVerifier(跨独立信号确认)返回 true
 * 仅①过 → 拒(相关性 ≠ 正确性,历史相关但测量错的谓词会被挡)
 * 仅②过 → 拒(统计不足,跨信号确认的样本不够)
 * 都过 → 升层候选(实际升层 = 标记可信赖,trust 仍 observation,因测量有效性主张
 *   仍 World 只读,升层不改变可信根归属)
 *
 * 层3 跨信号仲裁未实现(T3.3),crossSignalVerifier 用可注入占位:
 *   - 默认 reject(未跨信号确认 → 拒升层,保守)
 *   - 真实层3 接线后注入实际 verifier
 *
 * 见 docs/self-evolution-loop.md D6 / §5.3 acceptance-spec。
 */

export interface PromotionGateThresholds {
  /** 最小样本量(冷启动保护 — 数据不足不升层)。默认 10。 */
  minProofCount: number;
  /** 最低成功率(达此才考虑升层,失败率高不升)。默认 0.7。 */
  minSuccessRate: number;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionGateThresholds = {
  minProofCount: 10,
  minSuccessRate: 0.7,
};

export type CrossSignalVerifier = (skill: string) => Promise<boolean> | boolean;

export interface PromotionDecision {
  promotable: boolean;
  reason: string;
  /** ① 统计门槛是否过。 */
  statisticalPassed: boolean;
  /** ② 跨信号门槛是否过。 */
  crossSignalPassed: boolean;
}

/**
 * 评估一个 skill 的契约能否升层(层2 → 层1)。
 * @param stats 该 skill 的 Observation 统计(来自 observation-aggregator)
 * @param crossSignalVerifier 跨信号确认器。默认全 reject(层3 未实现,保守拒升层)。
 * @param thresholds 阈值
 */
export async function evaluatePromotion(
  stats: ObservationStats,
  crossSignalVerifier: CrossSignalVerifier = async () => false,
  thresholds: PromotionGateThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): Promise<PromotionDecision> {
  // ① 统计置信度门槛
  const statisticalPassed =
    stats.proofCount >= thresholds.minProofCount && stats.successRate >= thresholds.minSuccessRate;

  // ② 测量有效性门槛(跨信号确认)
  let crossSignalPassed = false;
  if (statisticalPassed) {
    // 统计没过就不费跨信号(短路 — 冷启动期不调用 verifier)
    crossSignalPassed = await Promise.resolve(crossSignalVerifier(stats.skill));
  }

  // 双门槛都过才升层
  const promotable = statisticalPassed && crossSignalPassed;

  let reason: string;
  if (promotable) {
    reason = '升层候选:统计置信度 + 跨信号有效性双门槛均过(D6)';
  } else if (!statisticalPassed) {
    if (stats.proofCount < thresholds.minProofCount) {
      reason = `拒升层:样本不足 proofCount=${stats.proofCount} < ${thresholds.minProofCount}(冷启动保护)`;
    } else {
      reason = `拒升层:成功率 ${stats.successRate.toFixed(2)} < ${thresholds.minSuccessRate}`;
    }
  } else {
    // 统计过但跨信号没过 — 这是关键:相关性≠正确性
    reason = `拒升层:统计置信度过但跨信号有效性未确认(相关性 ≠ 正确性,D6)`;
  }

  return { promotable, reason, statisticalPassed, crossSignalPassed };
}
