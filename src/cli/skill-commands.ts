/**
 * `moss skill create <name>` — scaffold a SKILL.md in `.moss/skills/<name>/`.
 * The template carries frontmatter hints (name/description/when) and an
 * $ARGUMENTS placeholder, so the model can call the skill with arguments the
 * moment the user edits the description.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isZhLocale } from './cli-locale.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function renderSkillUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss skill create <name>          生成 .moss/skills/<name>/SKILL.md 脚手架',
      '  moss skill list                   列出已发现的 skills（工作区 + 用户级）',
      '',
      '编辑脚手架、补全 description 与正文；下次启动 moss 自动加载（渐进披露：',
      '只有 name + description 进入提示词；正文经 skill 工具按 {args} 加载）。',
    ].join('\n');
  }
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
  const zh = isZhLocale();

  if (sub === 'create') {
    const name = argv[1];
    if (!name) {
      err(
        'moss skill create: ' +
          (zh ? '需要 skill 名称。\n\n' : 'a skill name is required.\n\n') +
          renderSkillUsage(zh)
      );
      return 2;
    }
    if (!SKILL_NAME_RE.test(name)) {
      err(`moss skill create: name "${name}" must be alphanumeric/-/_/.`);
      return 2;
    }
    const skillDir = path.join(ctx.workspaceDir, '.moss', 'skills', name);
    const filePath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(filePath)) {
      err(
        zh
          ? `moss skill create: "${name}" 已存在（${filePath}）`
          : `moss skill create: "${name}" already exists at ${filePath}`
      );
      return 1;
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(filePath, SKILL_TEMPLATE.replaceAll('{{NAME}}', name), 'utf8');
    out(zh ? `已创建 ${filePath}` : `Created ${filePath}`);
    out(
      zh
        ? '编辑 description 与正文后启动 moss——skill 会自动加载。'
        : 'Edit description + body, then start moss — the skill loads automatically.'
    );
    return 0;
  }

  if (sub === 'list') {
    const { loadSkills } = await import('../core/skills/skill-registry.js');
    const skills = loadSkills([
      path.join(ctx.workspaceDir, '.moss', 'skills'),
      path.join(ctx.configDir, 'skills'),
    ]);
    if (skills.length === 0) {
      out(
        zh
          ? '未发现 skills。创建一个：moss skill create <name>'
          : 'No skills found. Create one: moss skill create <name>'
      );
      return 0;
    }
    for (const skill of skills) out(`  ${skill.name.padEnd(18)} ${skill.description}`);
    out(
      zh
        ? `\n共 ${skills.length} 个 skill。会话内用 skill 工具加载。`
        : `\n${skills.length} skill(s). Load one in-session with the skill tool.`
    );
    return 0;
  }

  err(renderSkillUsage(zh));
  return 2;
}
