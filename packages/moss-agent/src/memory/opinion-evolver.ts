import type { MemoryManager } from './memory-manager.js';
import { memoryWarn } from './logger.js';

/**
 * Opinion 演化(T2.3)— HINDSIGHT Opinion 层:带置信度的主观判断,随证据增减。
 *
 * Opinion vs Observation:
 *  - Observation = 一阶归纳(中立统计:"rdk-device 失败率 28.6%")— 已做
 *  - Opinion = 二阶推断(主观:"rdk-device 在 S100 不可靠,建议改用 X")+ 置信度 + freshness
 *
 * 数据形态(不动 MemoryEntry 结构):
 *  - content: 人可读判断文本
 *  - topic: 编码的 OpinionMeta(opinion:confidence=0.7;freshness=stable;...)
 *  - trust: 'opinion'
 *
 * 演化(D6 + spec §5.2):
 *  - 支持证据 → confidence ↑,freshness → strengthening/stable
 *  - 矛盾证据 → confidence ↓,freshness → weakening
 *  - 不删除(保留证据链,供层 3 仲裁)
 *  - 软演化用 freshness;硬作废(固件/板子变更)用 supersedes(标旧 Opinion 失效)
 *
 * 见 docs/self-evolution-loop.md §5.2 / D5 / D6。
 */

export type Freshness = 'new' | 'strengthening' | 'stable' | 'weakening' | 'stale';

export interface OpinionMeta {
  confidence: number; // [0, 1]
  freshness: Freshness;
  supports: number; // 支持证据数
  contradicts: number; // 矛盾证据数
  /** 硬作废:指向取代此 Opinion 的新 id(此 Opinion 不参与后续召回)。 */
  supersededBy?: string;
}

const FRESHNESS_ORDER: Freshness[] = ['new', 'strengthening', 'stable', 'weakening', 'stale'];

/** 把 OpinionMeta 编码进 topic 字段(可往返)。 */
export function encodeOpinionMeta(meta: OpinionMeta): string {
  const parts = [
    `opinion:confidence=${meta.confidence.toFixed(3)}`,
    `freshness=${meta.freshness}`,
    `supports=${meta.supports}`,
    `contradicts=${meta.contradicts}`,
  ];
  if (meta.supersededBy) parts.push(`supersededBy=${meta.supersededBy}`);
  return parts.join(';');
}

/** 从 topic 解码 OpinionMeta。非 opinion topic 返回 null。 */
export function parseOpinionMeta(topic: string | undefined): OpinionMeta | null {
  if (!topic || !topic.startsWith('opinion:')) return null;
  // 剥 'opinion:' 前缀,剩下 "confidence=...;freshness=...;..." 便于 (;|^)key= 匹配
  const body = topic.slice('opinion:'.length);
  const get = (key: string): string | undefined => {
    const m = new RegExp(`(?:^|;)${key}=([^;]+)`).exec(body);
    return m?.[1];
  };
  const confidence = Number(get('confidence'));
  const freshness = get('freshness') as Freshness | undefined;
  const supports = Number(get('supports') ?? 0);
  const contradicts = Number(get('contradicts') ?? 0);
  const supersededBy = get('supersededBy');
  if (Number.isNaN(confidence) || !freshness || !FRESHNESS_ORDER.includes(freshness)) return null;
  const meta: OpinionMeta = { confidence, freshness, supports, contradicts };
  if (supersededBy) meta.supersededBy = supersededBy;
  return meta;
}

/** 置信度增减,钳到 [0,1]。证据强度权重:支持 +step,矛盾 -step。 */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * 演化一个 Opinion:喂入新证据,更新置信度/freshness/证据计数。
 * 不删除 Opinion — 证据计数累加,freshness 反映趋势,供层 3 仲裁。
 *
 * @param opinionId MemoryManager 中的 Opinion 条目 id
 * @param evidence 'support' | 'contradict'
 * @param weight 证据强度(默认 0.1,强证据可调大)
 * @returns 更新后的 OpinionMeta,或 null(条目不存在/非 Opinion)
 */
export async function evolveOpinion(
  memoryManager: MemoryManager,
  opinionId: string,
  evidence: 'support' | 'contradict',
  weight = 0.1,
): Promise<OpinionMeta | null> {
  try {
    const entry = await memoryManager.getById(opinionId);
    if (!entry || entry.trust !== 'opinion') return null;

    // 硬作废的 Opinion 不再演化(supersededBy 已设)
    const current = parseOpinionMeta(entry.topic);
    if (!current) return null;
    if (current.supersededBy) return null; // 已硬作废,拒演化

    // 置信度增减 + 证据计数
    const delta = evidence === 'support' ? weight : -weight;
    const newConfidence = clamp01(current.confidence + delta);
    const supports = current.supports + (evidence === 'support' ? 1 : 0);
    const contradicts = current.contradicts + (evidence === 'contradict' ? 1 : 0);

    // freshness 转换(D6 + spec §5.2)
    let freshness: Freshness = current.freshness;
    if (evidence === 'support') {
      // 支持 → strengthening(若原 weakening/stale 先回 stable 再 strengthening,简化为 strengthening)
      freshness = newConfidence >= 0.6 ? 'stable' : 'strengthening';
    } else {
      // 矛盾 → weakening;持续矛盾到低置信度 → stale
      freshness = newConfidence < 0.3 ? 'stale' : 'weakening';
    }

    const newMeta: OpinionMeta = {
      confidence: newConfidence,
      freshness,
      supports,
      contradicts,
    };
    const newTopic = encodeOpinionMeta(newMeta);
    await memoryManager.update(opinionId, { topic: newTopic });
    return newMeta;
  } catch (err) {
    memoryWarn('opinion evolution failed:', err);
    return null;
  }
}

/**
 * 硬作废一个 Opinion(固件/板子变更场景 — 旧结论对当前决策无价值反有害)。
 * 区别于软演化 freshness:硬作废直接标 supersededBy,旧 Opinion 不参与后续召回。
 * @param opinionId 旧 Opinion
 * @param supersededBy 取代它的新 Opinion id
 */
export async function hardSupersedeOpinion(
  memoryManager: MemoryManager,
  opinionId: string,
  supersededBy: string,
): Promise<boolean> {
  try {
    const entry = await memoryManager.getById(opinionId);
    if (!entry || entry.trust !== 'opinion') return false;
    const current = parseOpinionMeta(entry.topic) ?? {
      confidence: 0.5, freshness: 'stable', supports: 0, contradicts: 0,
    };
    const newMeta: OpinionMeta = { ...current, supersededBy };
    await memoryManager.update(opinionId, { topic: encodeOpinionMeta(newMeta) });
    return true;
  } catch (err) {
    memoryWarn('opinion hard-supersede failed:', err);
    return false;
  }
}

/** 创建新 Opinion。返回条目 id。 */
export async function createOpinion(
  memoryManager: MemoryManager,
  content: string,
  initialConfidence = 0.5,
  scope?: 'workspace' | 'device',
  scopeRef?: string,
): Promise<string> {
  const meta: OpinionMeta = {
    confidence: initialConfidence,
    freshness: 'new',
    supports: 0,
    contradicts: 0,
  };
  return memoryManager.add(content, 'memory', undefined, {
    trust: 'opinion',
    scope,
    scopeRef,
    topic: encodeOpinionMeta(meta),
  });
}
