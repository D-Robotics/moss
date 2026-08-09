/**
 * SkillLoadNudge — mid-run reminder after installing a skill without loading it.
 *
 * SkillHub / install_skill write SKILL.md to disk but do not inject instructions
 * into the current turn until `load_skill` runs. Soft: max 1 fire per run.
 */

export const SKILL_LOAD_NUDGE_MAX_ATTEMPTS = 1;

const INSTALL_TOOLS = new Set(['skillhub_install', 'install_skill']);

export interface SkillLoadNudgeRequest {
  toolCallsByName: Record<string, number>;
  attempts: number;
}

export type SkillLoadNudgeResult = { fire: false } | { fire: true; correction: string };

export function evaluateSkillLoadNudge(request: SkillLoadNudgeRequest): SkillLoadNudgeResult {
  if (request.attempts >= SKILL_LOAD_NUDGE_MAX_ATTEMPTS) return { fire: false };

  let installs = 0;
  for (const name of INSTALL_TOOLS) {
    installs += request.toolCallsByName[name] ?? 0;
  }
  if (installs === 0) return { fire: false };

  if ((request.toolCallsByName.load_skill ?? 0) > 0) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] You installed a skill (`skillhub_install` / `install_skill`) but have not called `load_skill` yet. ' +
      'Installing only writes SKILL.md to the workspace — it does **not** load instructions for this turn. ' +
      'Call `load_skill` with the skill name/slug now (unless you intentionally only wanted it for future sessions), ' +
      'then follow the skill body for the current task.',
  };
}
