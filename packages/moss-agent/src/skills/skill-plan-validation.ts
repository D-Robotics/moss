import { deriveSkillStableId } from './registry.js';
import { skillEligibilityReason } from './skill-retriever.js';
import type { SkillComposeInput, SkillPlan } from './composer-types.js';

export interface SkillPlanValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSkillPlan(
  plan: SkillPlan,
  input: SkillComposeInput
): SkillPlanValidationResult {
  const errors: string[] = [];
  if (!Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) {
    errors.push('confidence must be between 0 and 1');
  }
  if (plan.skills.length > input.maxSkills) errors.push('plan exceeds maxSkills');
  if (plan.rejected !== (plan.skills.length === 0)) {
    errors.push('rejected must match empty plan state');
  }
  const byId = new Map(
    input.skills.map((skill) => [skill.stableId ?? deriveSkillStableId(skill), skill])
  );
  const seen = new Set<string>();
  for (const planned of plan.skills) {
    if (seen.has(planned.stableId)) errors.push(`duplicate skill ${planned.stableId}`);
    seen.add(planned.stableId);
    const meta = byId.get(planned.stableId);
    if (!meta) {
      errors.push(`unknown skill ${planned.stableId}`);
      continue;
    }
    const ineligible = skillEligibilityReason(meta, input.environment);
    if (ineligible) errors.push(`ineligible skill ${planned.name}: ${ineligible}`);
  }
  const position = new Map(plan.skills.map((skill, index) => [skill.stableId, index]));
  const byReference = new Map<string, string>();
  for (const skill of input.skills) {
    const id = skill.stableId ?? deriveSkillStableId(skill);
    byReference.set(id.toLowerCase(), id);
    byReference.set(skill.name.toLowerCase(), id);
  }
  for (const planned of plan.skills) {
    const meta = byId.get(planned.stableId);
    if (!meta) continue;
    for (const reference of meta.requires ?? []) {
      const requiredId = byReference.get(reference.toLowerCase());
      if (!requiredId || !position.has(requiredId)) {
        errors.push(`${planned.name} requires missing ${reference}`);
      } else if (position.get(requiredId)! > position.get(planned.stableId)!) {
        errors.push(`${planned.name} appears before required ${reference}`);
      }
    }
    for (const reference of meta.before ?? []) {
      const targetId = byReference.get(reference.toLowerCase());
      if (
        targetId &&
        position.has(targetId) &&
        position.get(planned.stableId)! > position.get(targetId)!
      ) {
        errors.push(`${planned.name} must appear before ${reference}`);
      }
    }
    for (const reference of meta.after ?? []) {
      const targetId = byReference.get(reference.toLowerCase());
      if (
        targetId &&
        position.has(targetId) &&
        position.get(planned.stableId)! < position.get(targetId)!
      ) {
        errors.push(`${planned.name} must appear after ${reference}`);
      }
    }
    for (const reference of meta.conflicts ?? []) {
      const targetId = byReference.get(reference.toLowerCase());
      if (targetId && position.has(targetId))
        errors.push(`${planned.name} conflicts with ${reference}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
