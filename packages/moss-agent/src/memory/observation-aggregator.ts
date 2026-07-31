import type { ExperienceEntry, ExperienceLog } from './experience-log.js';
import type { MemoryManager } from './memory-manager.js';
import { memoryWarn } from './logger.js';

/**
 * Observation 离线聚合器(T2.2)— 从 Experience 轨迹提炼一阶规律。
 *
 * HINDSIGHT 四层里 Experience(轨迹,已有)→ Observation(中性归纳,本层)。
 * 聚合每个 skill 的成功率/失败率/样本量,写成 trust=observation 的 MemoryEntry
 * 存进 MemoryManager,带 proofCount(样本量,D6 升层闸的统计置信度来源)。
 *
 * 设计:
 *  - 异步跑(定时/手动触发),不阻塞对话(HINDSIGHT 4.2 同构)
 *  - 客观来源:数据来自 Experience(verdict 是验证器客观判定,非模型自报)
 *  - observation 条目 trust=observation(可演化层),skill + 统计为 content,
 *    覆盖更新(同 skill 重新聚合 → update 已有条目,带 proofCount)
 *  - 不碰 world 层(D5:observation 是归纳,测量有效性主张仍在 world 只读)
 *
 * 见 docs/self-evolution-loop.md §5.2 hindsight-memory / D5 / D6。
 */

export interface ObservationStats {
  skill: string;
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  successRate: number; // pass / (pass + fail),unknown 不计入分母(未判定不算成败)
  proofCount: number; // 样本量(用于 D6 升层闸统计置信度)
  failureReasons: Record<string, number>; // 失败原因码 → 次数
}

/** 按契约 skill 聚合 Experience(只统计有 contractSkill 的条目)。 */
export function aggregateBySkill(entries: ExperienceEntry[]): Map<string, ObservationStats> {
  const bySkill = new Map<string, ObservationStats>();
  for (const e of entries) {
    const skill = e.diagnostics?.contractSkill;
    if (typeof skill !== 'string') continue; // 无契约条目不统计(L2 通用判定,非契约语义)
    let stats = bySkill.get(skill);
    if (!stats) {
      stats = { skill, total: 0, pass: 0, fail: 0, unknown: 0, successRate: 0, proofCount: 0, failureReasons: {} };
      bySkill.set(skill, stats);
    }
    stats.total += 1;
    if (e.verdict === 'pass') stats.pass += 1;
    else if (e.verdict === 'fail') {
      stats.fail += 1;
      const reason = String(e.reasonCode ?? 'unknown_reason');
      stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
    } else stats.unknown += 1;
  }
  // 算成功率
  for (const stats of bySkill.values()) {
    const decided = stats.pass + stats.fail;
    stats.successRate = decided > 0 ? stats.pass / decided : 0;
    stats.proofCount = decided; // proofCount = 有明确判定的样本量
  }
  return bySkill;
}

/** 把单个 skill 的统计写成 observation MemoryEntry content(人可读 + 可解析)。 */
export function formatObservationContent(stats: ObservationStats): string {
  const topFailures = Object.entries(stats.failureReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, n]) => `${r}(${n})`)
    .join(', ');
  return [
    `Observation: skill=${stats.skill}`,
    `successRate=${(stats.successRate * 100).toFixed(1)}% (${stats.pass}/${stats.pass + stats.fail} decided, ${stats.unknown} unknown)`,
    `proofCount=${stats.proofCount} total=${stats.total}`,
    topFailures ? `topFailures=${topFailures}` : 'topFailures=none',
  ].join(' | ');
}

export interface ObservationAggregatorOptions {
  experienceLog: ExperienceLog;
  memoryManager: MemoryManager;
  /** observation 条目的 scope(默认 'workspace')。 */
  scope?: 'workspace' | 'device';
  scopeRef?: string;
}

export class ObservationAggregator {
  constructor(private readonly opts: ObservationAggregatorOptions) {}

  /**
   * 聚合 Experience → 写 observation 条目。异步,不抛(失败只 warn)。
   * 返回聚合的 skill 数(测试/审计用)。
   */
  async aggregate(): Promise<number> {
    try {
      const entries = await this.opts.experienceLog.readAll();
      const stats = aggregateBySkill(entries);
      // T2.2 已知限制修复:重聚合前先删旧的"自产 observation"(topic 以 proofCount= 开头),
      // 让覆盖更新生效(之前 content 变则新增,累积旧快照)。deleteByTrust 的 topicPrefix
      // 精筛确保只删本聚合器产物,不误删用户写的同 trust 条目。
      await this.opts.memoryManager.deleteByTrust('observation', {
        scope: this.opts.scope,
        scopeRef: this.opts.scopeRef,
        topicPrefix: 'proofCount=',
      });
      for (const s of stats.values()) {
        const content = formatObservationContent(s);
        // 用稳定 id(同 skill 重新聚合覆盖同一条目,但 observation 可演化,非 world,允许)
        const id = `obs_${s.skill}`;
        // 直接写:若已存在则更新,否则新增。observation 是归纳结论,可覆盖更新
        // (不像 Experience append-only;observation 是当前快照)。
        await this.upsertObservation(id, content, s);
      }
      return stats.size;
    } catch (err) {
      memoryWarn('observation aggregation failed:', err);
      return 0;
    }
  }

  private async upsertObservation(id: string, content: string, stats: ObservationStats): Promise<void> {
    void id; // 本切片:不指定稳定 id(MemoryManager.add 用 content hash 去重)
    const mm = this.opts.memoryManager;
    // add 按 content hash 去重:同 content(同 skill 同统计)不新增。
    // 注:统计变了 → content 变 → hash 变 → 新增。重复聚合累积是已知限制,
    // 待 MemoryManager 加"按 trust 删除/按 key 更新"接口后改为覆盖更新。
    await mm.add(content, 'memory', undefined, {
      trust: 'observation',
      scope: this.opts.scope,
      scopeRef: this.opts.scopeRef,
      topic: `proofCount=${stats.proofCount}`,
    });
  }
}
