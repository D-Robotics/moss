import fs from 'node:fs';
import type { Tool } from '../core/tools/tool-types.js';
import { findSkill, parseSkillFile, type SkillManifest } from '../core/skills/skill-registry.js';

const MAX_SKILL_BODY_CHARS = 24_000;

export interface SkillToolInput {
  name: string;
  /** Free-form arguments injected into $ARGUMENTS placeholders in the body. */
  args?: string;
}

/** Session-level body cache: file mtime is the invalidation key. */
const bodyCache = new Map<string, { mtimeMs: number; body: string }>();

export function readSkillBodyCached(skill: SkillManifest): string {
  const stat = fs.statSync(skill.file);
  const cached = bodyCache.get(skill.file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.body;
  const body = parseSkillFile(fs.readFileSync(skill.file, 'utf8')).body;
  bodyCache.set(skill.file, { mtimeMs: stat.mtimeMs, body });
  return body;
}

export function createSkillTool(skills: readonly SkillManifest[]): Tool<SkillToolInput> {
  return {
    name: 'skill',
    description:
      'Load the full instructions of a discovered skill by name. Only the skill index (name + description) is in context; the body loads on demand through this tool. Pass {args} to fill $ARGUMENTS placeholders in the body.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow', requiresApproval: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name exactly as listed in the Available skills index.',
        },
        args: {
          type: 'string',
          description:
            'Optional free-form arguments; replaces every $ARGUMENTS placeholder in the skill body.',
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
        body = readSkillBodyCached(skill);
      } catch {
        return `Skill "${skill.name}" could not be read from ${skill.file}`;
      }
      const args = typeof input.args === 'string' ? input.args : '';
      if (body.includes('$ARGUMENTS')) body = body.replaceAll('$ARGUMENTS', args);
      const clipped =
        body.length > MAX_SKILL_BODY_CHARS
          ? `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[... skill body truncated ...]`
          : body;
      return `# Skill: ${skill.name}\n${skill.when ? `When: ${skill.when}\n` : ''}\n${clipped}`;
    },
  };
}
