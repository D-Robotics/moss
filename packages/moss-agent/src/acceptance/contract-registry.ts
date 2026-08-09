import type { SkillMeta } from '../skills/types.js';
import type { SkillAcceptanceContract } from './types.js';
import { loadAcceptanceContracts } from './contract-loader.js';

/**
 * 契约注册表(T3.1)— 加载所有 skill 契约,建 tool→contracts 反查索引。
 *
 * 解 C(无 plan 时按 tool 反查契约):契约声明 expectedTools(覆盖哪些工具名),
 * hook 收到工具调用 → findByTool(toolName, input) → 找到契约跑其 postconditions。
 * 解 A(有 plan 时查 PlanStep.expectedAccept)待 PlanStep 接线后另加。
 *
 * 多契约覆盖同 tool(解多覆盖):device_exec 是通用工具,多个 skill 都调它,
 * 单靠 expectedTools 无法区分。解法 = expectedCommandPattern:
 *  - 契约可声明 expectedCommandPattern(正则,匹配 input.command)
 *  - findByTool 筛选:① 有 pattern 且 input.command 匹配的契约候选(优先)
 *                   ② 无 pattern 的通用兜底契约候选(次之)
 *                   ③ input 无 command 字段 → 只能用无 pattern 兜底
 *  - 多候选取第一个(加载顺序,可审计);无候选返回 undefined
 * 例:device_exec 跑 hb_mapper → rdk-device(pattern 命中);
 *     跑 ros2 launch → rdk-ros;跑 xburn → rdk-board-knowledge(无 pattern 兜底)。
 *
 * 见 docs/self-evolution-loop.md §5.3 / D4 / D10。
 */
export class ContractRegistry {
  private bySkill = new Map<string, SkillAcceptanceContract>();
  private byTool = new Map<string, SkillAcceptanceContract[]>();

  constructor(contracts: Map<string, SkillAcceptanceContract>) {
    for (const contract of contracts.values()) {
      this.bySkill.set(contract.skillName, contract);
      for (const tool of contract.expectedTools ?? []) {
        const list = this.byTool.get(tool);
        if (list) list.push(contract);
        else this.byTool.set(tool, [contract]);
      }
    }
  }

  /** 从 SkillRegistry 加载所有契约,建索引。无契约的 skill 静默跳过。 */
  static fromSkills(skills: SkillMeta[]): ContractRegistry {
    return new ContractRegistry(loadAcceptanceContracts(skills));
  }

  /** 按 skill 名取契约(有 plan 时 PlanStep.expectedAccept 引用 skill 名用)。 */
  findBySkill(skillName: string): SkillAcceptanceContract | undefined {
    return this.bySkill.get(skillName);
  }

  /**
   * 按 tool 名反查契约(解 C + 多覆盖)。
   * @param toolName 工具名
   * @param input 工具入参(含 command 时用于 pattern 匹配,区分同 tool 多契约)
   * @returns 命中契约或 undefined
   */
  findByTool(
    toolName: string,
    input?: Record<string, unknown>
  ): SkillAcceptanceContract | undefined {
    const list = this.byTool.get(toolName);
    if (!list || list.length === 0) return undefined;
    if (list.length === 1) return list[0];

    // 多契约覆盖:按 input.command 筛选
    const command = typeof input?.command === 'string' ? input.command : null;

    // ① 有 pattern 且 command 匹配的候选(优先)
    if (command) {
      for (const c of list) {
        if (c.expectedCommandPattern) {
          try {
            if (new RegExp(c.expectedCommandPattern).test(command)) return c;
          } catch {
            // 坏 pattern(loader 已校验,双保险)跳过
          }
        }
      }
    }
    // ② 无 pattern 的通用兜底候选(次之)
    for (const c of list) {
      if (!c.expectedCommandPattern) return c;
    }
    // ③ 有 command 但所有契约都有 pattern 且都没命中 → undefined(不兜底,避免误判)
    return undefined;
  }

  /** 已加载契约数(测试/审计用)。 */
  size(): number {
    return this.bySkill.size;
  }

  /** 覆盖某 tool 的契约数(测试/审计用,看多覆盖情况)。 */
  coverage(toolName: string): number {
    return this.byTool.get(toolName)?.length ?? 0;
  }
}
