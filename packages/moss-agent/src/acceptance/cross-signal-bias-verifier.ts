import type { PromotionCandidate, CandidateCrossSignalVerifier } from './promotion-coordinator.js';

/**
 * 跨信号偏差检测验证器(D6 ② 测量有效性跨信号确认)— injectable。
 *
 * U5 反例的核心逻辑(见 docs/self-evolution-loop.md 附录 B):一个谓词(如视觉
 * pose_error_within)的测量值与**独立信号**(如关节编码器)的同物理量对比,
 * 若存在系统性偏差(两信号恒定差),说明测量本身无效(相关性是假的)→ 拒升层。
 *
 * 本切片把 U5 的偏差检测逻辑抽成 **injectable factory**,让 crossSignalVerifier
 * 从"死桩 () => false"变成"真函数 + 注入缝"。production 保守(无独立参考→false),
 * 但验证器是真的、可注入、可通过 evaluatePromotion 端到端跑通。
 *
 * 物理独立信号读取(编码器 vs 视觉)留 follow-up(需板子特定只读命令,如
 * force_below 的 readCommand)。本切片先把闸打通。
 *
 * 见 docs/self-evolution-loop.md D6 / 附录 B / T3.4 closure。
 */

export interface BiasDetectionDeps {
  /** 候选自身测量数组(如视觉 pose 误差,来自 terminal-verdict log 证据)。返 null = 无样本。 */
  measurementExtractor?: (candidate: PromotionCandidate) => Promise<number[] | null> | number[] | null;
  /** 独立信号的同物理量数组(如编码器算的 pose 误差)。返 null = 无独立参考(production)。 */
  biasReference?: (candidate: PromotionCandidate) => Promise<number[] | null> | number[] | null;
  /** 可接受的均方差阈值(两信号均值差),超此=系统偏差。默认 0(任何一致非零偏差都拒)。 */
  biasTolerance?: number;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/**
 * 偏差检测:取候选测量 vs 独立参考的逐样本差值。
 *  - 差值一致(stddev 极小,说明是系统偏差而非噪声)+ 均值超 tolerance → 系统偏差 → false
 *  - 差值在 tolerance 内(信号一致)→ true
 *  - 任一信号缺/长度不匹配 → false(无法确认,保守拒)
 */
export function createBiasDetectionVerifier(deps: BiasDetectionDeps = {}): CandidateCrossSignalVerifier {
  const tolerance = deps.biasTolerance ?? 0;
  return async (candidate: PromotionCandidate): Promise<boolean> => {
    // 无独立参考 → 保守拒(production 默认,等物理读取接入)
    if (!deps.biasReference) return false;
    let reference: number[] | null;
    try {
      reference = await Promise.resolve(deps.biasReference(candidate));
    } catch {
      return false;
    }
    if (!reference || reference.length === 0) return false;

    if (!deps.measurementExtractor) return false;
    let measurements: number[] | null;
    try {
      measurements = await Promise.resolve(deps.measurementExtractor(candidate));
    } catch {
      return false;
    }
    if (!measurements || measurements.length === 0) return false;

    // 长度不匹配 → 无法逐样本对比 → 保守拒
    if (measurements.length !== reference.length) return false;

    const deltas = measurements.map((m, i) => m - reference[i]);
    const biasMean = mean(deltas);
    const biasSpread = stddev(deltas);

    // 信号一致(差值都在 tolerance 内)→ 测量有效性确认
    if (Math.abs(biasMean) <= tolerance && biasSpread <= tolerance) return true;
    // 差值一致但非零(系统偏差)→ 测量无效;或差值大(噪声也说明不一致)→ 测量无效
    return false;
  };
}
