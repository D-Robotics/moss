import type { SkillPlan } from './composer-types.js';

const MAX_ACTIVE_PLANS = 512;
const activePlans = new Map<string, SkillPlan>();

export function setActiveSkillPlan(sessionKey: string, plan: SkillPlan): void {
  if (!sessionKey.trim()) return;
  activePlans.delete(sessionKey);
  activePlans.set(sessionKey, plan);
  while (activePlans.size > MAX_ACTIVE_PLANS) {
    const oldest = activePlans.keys().next().value as string | undefined;
    if (!oldest) break;
    activePlans.delete(oldest);
  }
}

export function getActiveSkillPlan(sessionKey: string): SkillPlan | undefined {
  return activePlans.get(sessionKey);
}

export function clearActiveSkillPlan(sessionKey: string): void {
  activePlans.delete(sessionKey);
}

export function activePlanHasSkill(sessionKey: string, nameOrId: string): boolean {
  const query = nameOrId.trim().toLowerCase();
  return (
    getActiveSkillPlan(sessionKey)?.skills.some(
      (skill) => skill.name.toLowerCase() === query || skill.stableId.toLowerCase() === query
    ) ?? false
  );
}
