/**
 * `moss skill create <name>` — scaffold a SKILL.md in `.moss/skills/<name>/`.
 * The template carries frontmatter hints (name/description/when) and an
 * $ARGUMENTS placeholder, so the model can call the skill with arguments the
 * moment the user edits the description.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function renderSkillUsage(): string {
  return [
    'Usage:',
    '  moss skill create <name>          scaffold .moss/skills/<name>/SKILL.md',
    '  moss skill list                   list discovered skills (workspace + user)',
    '',
    'Edit the scaffold, fill in description + body; it appears in the next',
    'session automatically (progressive disclosure: only name + description',
    'enter the prompt; the body loads via the skill tool with {args}).',
  ].join('\n');
}

export const SKILL_TEMPLATE = `---
name: {{NAME}}
description: <one line: what this skill does and when to reach for it>
when: <optional: trigger hint for the model>
---

# {{NAME}}

Write the skill body here. Everything below the frontmatter is loaded on
demand when the model calls the \`skill\` tool with this name.

Arguments: every \`$ARGUMENTS\` placeholder below is replaced by the tool's
optional {args} value, e.g. "Target: $ARGUMENTS".
`;

export interface SkillCommandContext {
  workspaceDir: string;
  configDir: string;
}

export async function runSkillCommand(argv: string[], ctx: SkillCommandContext): Promise<number> {
  const out = (text: string) => process.stdout.write(`${text}\n`);
  const err = (text: string) => process.stderr.write(`${text}\n`);
  const sub = argv[0] ?? 'list';

  if (sub === 'create') {
    const name = argv[1];
    if (!name) {
      err('moss skill create: a skill name is required.\n\n' + renderSkillUsage());
      return 2;
    }
    if (!SKILL_NAME_RE.test(name)) {
      err(`moss skill create: name "${name}" must be alphanumeric/-/_/.`);
      return 2;
    }
    const skillDir = path.join(ctx.workspaceDir, '.moss', 'skills', name);
    const filePath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(filePath)) {
      err(`moss skill create: "${name}" already exists at ${filePath}`);
      return 1;
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(filePath, SKILL_TEMPLATE.replaceAll('{{NAME}}', name), 'utf8');
    out(`Created ${filePath}`);
    out('Edit description + body, then start moss — the skill loads automatically.');
    return 0;
  }

  if (sub === 'list') {
    const { loadSkills } = await import('../core/skills/skill-registry.js');
    const skills = loadSkills([
      path.join(ctx.workspaceDir, '.moss', 'skills'),
      path.join(ctx.configDir, 'skills'),
    ]);
    if (skills.length === 0) {
      out('No skills found. Create one: moss skill create <name>');
      return 0;
    }
    for (const skill of skills) out(`  ${skill.name.padEnd(18)} ${skill.description}`);
    out(`\n${skills.length} skill(s). Load one in-session with the skill tool.`);
    return 0;
  }

  err(renderSkillUsage());
  return 2;
}
