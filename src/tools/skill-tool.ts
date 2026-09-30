import fs from 'node:fs';
import type { Tool } from '../core/tools/tool-types.js';
import { findSkill, parseSkillFile, type SkillManifest } from '../core/skills/skill-registry.js';

const MAX_SKILL_BODY_CHARS = 24_000;

export interface SkillToolInput {
  name: string;
}

export function createSkillTool(skills: readonly SkillManifest[]): Tool<SkillToolInput> {
  return {
    name: 'skill',
    description:
      'Load the full instructions of a discovered skill by name. Only the skill index (name + description) is in context; the body loads on demand through this tool.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow', requiresApproval: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name exactly as listed in the Available skills index.',
        },
      },
      required: ['name'],
    },
    async execute(input: SkillToolInput): Promise<string> {
      const skill = findSkill(skills, String(input.name ?? '').trim());
      if (!skill) {
        const available = skills.map((s) => s.name).join(', ') || '(none)';
        return `Unknown skill "${input.name}". Available skills: ${available}`;
      }
      let body: string;
      try {
        body = parseSkillFile(fs.readFileSync(skill.file, 'utf8')).body;
      } catch {
        return `Skill "${skill.name}" could not be read from ${skill.file}`;
      }
      const clipped =
        body.length > MAX_SKILL_BODY_CHARS
          ? `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[... skill body truncated ...]`
          : body;
      return `# Skill: ${skill.name}\n${skill.when ? `When: ${skill.when}\n` : ''}\n${clipped}`;
    },
  };
}
