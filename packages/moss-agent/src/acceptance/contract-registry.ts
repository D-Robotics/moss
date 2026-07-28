import type { SkillMeta } from '../skills/types.js';
import type { SkillAcceptanceContract } from './types.js';
import { loadAcceptanceContracts } from './contract-loader.js';

/**
 * 契约注册表(T3.1)— 加载所有 skill 契约,建 tool→contract 反查索引。
 *
 * 解 C(无 plan 时按 tool 反查契约):契约声明 expectedTools(覆盖哪些工具名),
 * hook 收到工具调用 → findByTool(toolName) → 找到契约就跑其 postconditions。
 * 解 A(有 plan 时查 PlanStep.expectedAccept)待 PlanStep 接线后另加。
 *
 * 多契约覆盖同 tool:取第一个匹配(加载顺序 = SkillRegistry list 顺序,按 updatedAt
 * 倒序)。后续可加优先级/特异性(更窄 expectedTools 优先)。
 *
 * 见 docs/self-evolution-loop.md §5.3 / D4 / D10。
 */
export class ContractRegistry {
  private bySkill = new Map<string, SkillAcceptanceContract>();
  private byTool = new Map<string, SkillAcceptanceContract>();

  constructor(contracts: Map<string, SkillAcceptanceContract>) {
    for (const contract of contracts.values()) {
      this.bySkill.set(contract.skillName, contract);
      for (const tool of contract.expectedTools ?? []) {
        // 第一个覆盖该 tool 的契约胜出(避免覆盖,可审计)
        if (!this.byTool.has(tool)) this.byTool.set(tool, contract);
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

  /** 按 tool 名反查契约(解 C:无 plan 时 hook 用)。无契约返回 undefined。 */
  findByTool(toolName: string): SkillAcceptanceContract | undefined {
    return this.byTool.get(toolName);
  }

  /** 已加载契约数(测试/审计用)。 */
  size(): number {
    return this.bySkill.size;
  }
}
