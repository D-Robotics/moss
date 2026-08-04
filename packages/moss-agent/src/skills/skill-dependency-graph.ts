import { deriveSkillStableId, getSkillAliases } from './registry.js';
import type { PlannedSkill } from './composer-types.js';
import type { SkillMeta } from './types.js';

export interface OrderedSkillsResult {
  skills: PlannedSkill[];
  warnings: string[];
}

function referenceMap(skills: SkillMeta[]): Map<string, SkillMeta> {
  const result = new Map<string, SkillMeta>();
  for (const skill of skills) {
    const id = skill.stableId ?? deriveSkillStableId(skill);
    for (const ref of [id, skill.name, ...getSkillAliases(skill)]) {
      if (!result.has(ref.toLowerCase())) result.set(ref.toLowerCase(), skill);
    }
  }
  return result;
}

function resolve(ref: string, refs: Map<string, SkillMeta>): SkillMeta | undefined {
  return refs.get(ref.trim().toLowerCase());
}

export function expandRequiredSkills(
  selected: PlannedSkill[],
  allSkills: SkillMeta[],
  maxSkills: number,
): PlannedSkill[] {
  const refs = referenceMap(allSkills);
  const byId = new Map(allSkills.map((skill) => [skill.stableId ?? deriveSkillStableId(skill), skill]));
  const result = [...selected];
  const seen = new Set(result.map((skill) => skill.stableId));
  for (let index = 0; index < result.length && result.length < maxSkills; index++) {
    const current = byId.get(result[index].stableId);
    if (!current) continue;
    for (const requirement of current.requires ?? []) {
      const required = resolve(requirement, refs);
      if (!required) continue;
      const stableId = required.stableId ?? deriveSkillStableId(required);
      if (seen.has(stableId) || required.enabled === false) continue;
      seen.add(stableId);
      result.push({
        stableId,
        name: required.name,
        score: Math.max(0.01, result[index].score - 0.01),
        reasonCode: `required-by:${current.name}`,
      });
      if (result.length >= maxSkills) break;
    }
  }
  return result;
}

function conflicts(skill: SkillMeta, other: SkillMeta, refs: Map<string, SkillMeta>): boolean {
  const otherId = other.stableId ?? deriveSkillStableId(other);
  const skillId = skill.stableId ?? deriveSkillStableId(skill);
  const left = (skill.conflicts ?? []).some((ref) => {
    const target = resolve(ref, refs);
    return target && (target.stableId ?? deriveSkillStableId(target)) === otherId;
  });
  const right = (other.conflicts ?? []).some((ref) => {
    const target = resolve(ref, refs);
    return target && (target.stableId ?? deriveSkillStableId(target)) === skillId;
  });
  return left || right;
}

export function resolveSkillConflicts(
  selected: PlannedSkill[],
  allSkills: SkillMeta[],
): OrderedSkillsResult {
  const refs = referenceMap(allSkills);
  const byId = new Map(allSkills.map((skill) => [skill.stableId ?? deriveSkillStableId(skill), skill]));
  const kept: PlannedSkill[] = [];
  const warnings: string[] = [];
  for (const planned of [...selected].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))) {
    const meta = byId.get(planned.stableId);
    if (!meta) continue;
    const conflict = kept.find((existing) => {
      const existingMeta = byId.get(existing.stableId);
      return existingMeta ? conflicts(meta, existingMeta, refs) : false;
    });
    if (conflict) {
      warnings.push(`Excluded ${planned.name}: conflicts with higher-ranked ${conflict.name}`);
      continue;
    }
    kept.push(planned);
  }
  return { skills: kept, warnings };
}

export function orderPlannedSkills(
  selected: PlannedSkill[],
  allSkills: SkillMeta[],
): OrderedSkillsResult {
  const warnings: string[] = [];
  const refs = referenceMap(allSkills);
  const byId = new Map(allSkills.map((skill) => [skill.stableId ?? deriveSkillStableId(skill), skill]));
  const plannedById = new Map(selected.map((skill) => [skill.stableId, skill]));
  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const skill of selected) {
    edges.set(skill.stableId, new Set());
    indegree.set(skill.stableId, 0);
  }
  const addEdge = (from: string, to: string): void => {
    if (from === to || !edges.has(from) || !edges.has(to) || edges.get(from)!.has(to)) return;
    edges.get(from)!.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };
  for (const planned of selected) {
    const meta = byId.get(planned.stableId);
    if (!meta) continue;
    for (const ref of [...(meta.requires ?? []), ...(meta.after ?? [])]) {
      const target = resolve(ref, refs);
      if (target) addEdge(target.stableId ?? deriveSkillStableId(target), planned.stableId);
    }
    for (const ref of meta.before ?? []) {
      const target = resolve(ref, refs);
      if (target) addEdge(planned.stableId, target.stableId ?? deriveSkillStableId(target));
    }
  }
  for (const left of selected) {
    const leftMeta = byId.get(left.stableId);
    if (!leftMeta || (leftMeta.outputs ?? []).length === 0) continue;
    const outputs = new Set(leftMeta.outputs!.map((value) => value.toLowerCase()));
    for (const right of selected) {
      if (left.stableId === right.stableId) continue;
      const rightMeta = byId.get(right.stableId);
      if ((rightMeta?.inputs ?? []).some((value) => outputs.has(value.toLowerCase()))) {
        addEdge(left.stableId, right.stableId);
      }
    }
  }
  const ready = [...selected]
    .filter((skill) => (indegree.get(skill.stableId) ?? 0) === 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const ordered: PlannedSkill[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const next of edges.get(current.stableId) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, value);
      if (value === 0) {
        ready.push(plannedById.get(next)!);
        ready.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      }
    }
  }
  if (ordered.length !== selected.length) {
    const remaining = selected
      .filter((skill) => !ordered.some((entry) => entry.stableId === skill.stableId))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    warnings.push(`Dependency cycle or unresolved ordering among: ${remaining.map((skill) => skill.name).join(', ')}`);
    ordered.push(...remaining);
  }
  return { skills: ordered, warnings };
}
