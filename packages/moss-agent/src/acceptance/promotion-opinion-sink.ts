import type { MemoryManager } from '../memory/memory-manager.js';
import type { PromotionDecisionRecord, PromotionDecisionSink } from './promotion-coordinator.js';
import { memoryWarn } from '../memory/logger.js';

export interface OpinionSinkDeps {
  memoryManager: MemoryManager;
  scope?: 'workspace' | 'device';
  scopeRef?: string;
}

/**
 * 把升层决策沉淀为一条 trust=observation 的 Opinion 记忆(T3.4 closure)。
 *
 * 关键(D6):升层不改变可信根归属。Opinion 是 trust=observation(可演化层),
 * 不是 trust=world(可信根)。即便决策 promotable=true,也只是"统计+跨信号
 * 双门槛都过"的归纳结论,测量有效性主张仍永久归属 World 层 —— 不会被这条
 * Opinion 赋予"自证可信"地位。本切片不动任何 ACCEPTANCE.json(契约物化留
 * 下一阶段)。
 *
 * 失败只 warn 不抛(副作用式,不影响 completion)。
 */
export function createOpinionSink(deps: OpinionSinkDeps): PromotionDecisionSink {
  return async (record: PromotionDecisionRecord) => {
    const { candidate, decision } = record;
    const content = [
      `Promotion Opinion: skill=${candidate.targetSkill}`,
      `candidate=${candidate.id}`,
      `provenance=${candidate.provenance.source}`,
      `promotable=${decision.promotable}`,
      `statisticalPassed=${decision.statisticalPassed}`,
      `crossSignalPassed=${decision.crossSignalPassed}`,
      `reason=${decision.reason}`,
    ].join(' | ');
    try {
      await deps.memoryManager.add(content, 'memory', undefined, {
        trust: 'observation',
        scope: deps.scope,
        scopeRef: deps.scopeRef,
        topic: `promotion:${candidate.targetSkill}`,
      });
    } catch (err) {
      memoryWarn('promotion opinion sink write failed:', err);
    }
  };
}
