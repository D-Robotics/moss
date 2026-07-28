import fs from 'node:fs';
import path from 'node:path';
import type { SkillMeta } from '../skills/types.js';
import { memoryWarn } from '../memory/logger.js';
import type { AcceptPredicateName, AcceptSpec, SkillAcceptanceContract } from './types.js';

/**
 * Skill 验收契约加载器(T3.1)。
 *
 * 从每个 skill 目录读 ACCEPTANCE.json(贴着 SKILL.md),JSON.parse 成 contract,按 skillName 索引。
 * 无契约的 skill 不报错(契约可选)。解析失败只 warn 不抛(不影响 skill 加载)。
 *
 * 选 JSON 而非 YAML:零依赖(JSON.parse 内置),无手写解析器 bug 面。代价是人写多几个
 * 引号/逗号,换来解析零风险。契约不常改,可读性代价可接受。
 *
 * D5 谓词名是白名单(World 只读):非白名单 name 拒。params 类型校验。
 * 见 docs/self-evolution-loop.md §5.3 acceptance-spec / D5。
 */

const PREDICATE_NAMES: ReadonlySet<string> = new Set<AcceptPredicateName>([
  'file_exist',
  'process_running',
  'pose_error_within',
  'force_below',
  'joint_at',
  'exit_code_zero',
  'stdout_matches',
  'video_fps_above',
]);

/** 校验单个谓词:白名单 + params 是对象。 */
function validatePredicate(p: unknown, skillName: string, section: string): p is AcceptSpec {
  if (!p || typeof p !== 'object') {
    memoryWarn(`acceptance contract ${skillName}: ${section} predicate not an object — rejected`);
    return false;
  }
  const pred = p as Record<string, unknown>;
  if (typeof pred.name !== 'string' || !PREDICATE_NAMES.has(pred.name)) {
    memoryWarn(`acceptance contract ${skillName}: ${section} unknown predicate ${String(pred.name)} (not in whitelist) — rejected`);
    return false;
  }
  if (!pred.params || typeof pred.params !== 'object' || Array.isArray(pred.params)) {
    memoryWarn(`acceptance contract ${skillName}: ${section} predicate ${pred.name} missing params object — rejected`);
    return false;
  }
  return true;
}

/** 校验并提取一个 section(若不存在返回 undefined;存在则校验每项)。 */
function extractSection(
  raw: unknown,
  skillName: string,
  section: keyof SkillAcceptanceContract,
): AcceptSpec[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    memoryWarn(`acceptance contract ${skillName}: ${section} must be an array — rejected`);
    return undefined;
  }
  const out: AcceptSpec[] = [];
  for (const p of raw) {
    if (validatePredicate(p, skillName, section)) out.push(p as AcceptSpec);
    else return undefined; // 任一坏谓词拒整个契约(D5 严格性)
  }
  return out;
}

export function parseAcceptanceContract(text: string, sourcePath: string): SkillAcceptanceContract | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    memoryWarn(`acceptance contract ${sourcePath}: invalid JSON —`, err);
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const skillName = String(obj.skillName ?? '').trim();
  if (!skillName) {
    memoryWarn(`acceptance contract missing skillName: ${sourcePath}`);
    return null;
  }
  const version = String(obj.version ?? '1').trim();
  const postconditions = extractSection(obj.postconditions, skillName, 'postconditions');
  if (!postconditions || postconditions.length === 0) {
    // postconditions 是核心,缺/空 → 不算契约
    memoryWarn(`acceptance contract ${skillName}: postconditions missing/empty — rejected`);
    return null;
  }
  const preconditions = extractSection(obj.preconditions, skillName, 'preconditions');
  const safetyConstraints = extractSection(obj.safetyConstraints, skillName, 'safetyConstraints');

  // expectedTools(解 C:无 plan 时按 tool 反查契约用)— 必须是字符串数组
  let expectedTools: string[] | undefined;
  if (obj.expectedTools !== undefined) {
    if (!Array.isArray(obj.expectedTools) || !obj.expectedTools.every((t) => typeof t === 'string')) {
      memoryWarn(`acceptance contract ${skillName}: expectedTools must be string[] — rejected`);
      return null;
    }
    expectedTools = obj.expectedTools as string[];
  }

  return { skillName, sourcePath, expectedTools, preconditions, postconditions, safetyConstraints, version };
}

/**
 * 从 SkillRegistry 的 list() 遍历,加载每个 skill 的 ACCEPTANCE.json。
 * 无文件/解析失败 → 跳过(warn),不影响其他 skill。
 */
export function loadAcceptanceContracts(skills: SkillMeta[]): Map<string, SkillAcceptanceContract> {
  const out = new Map<string, SkillAcceptanceContract>();
  for (const skill of skills) {
    if (!skill.sourcePath || skill.sourcePath.startsWith('builtin://')) continue;
    const dir = path.dirname(skill.sourcePath);
    const contractPath = path.join(dir, 'ACCEPTANCE.json');
    try {
      if (!fs.existsSync(contractPath)) continue;
      const text = fs.readFileSync(contractPath, 'utf-8');
      const contract = parseAcceptanceContract(text, contractPath);
      if (contract) out.set(skill.name, contract);
    } catch (err) {
      memoryWarn(`failed to load acceptance contract ${contractPath}:`, err);
    }
  }
  return out;
}
