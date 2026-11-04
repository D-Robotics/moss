/**
 * `moss skill create <name>` — scaffold a SKILL.md in `.moss/skills/<name>/`.
 * The template carries frontmatter hints (name/description/when) and an
 * $ARGUMENTS placeholder, so the model can call the skill with arguments the
 * moment the user edits the description.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isZhLocale } from './cli-locale.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function renderSkillUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss skill create <名称>          生成 .moss/skills/<名称>/SKILL.md 脚手架',
      '  moss skill list                   列出已发现的技能（工作区与用户级）',
      '  moss skill validate <路径>        按 Agent Skills 规范校验一个技能目录',
      '  moss skill install <源> [--workspace] [--name 名称] [--yes]',
      '                                    从目录 / git URL / npm 包安装并写锁文件',
      '  moss skill update [名称] [--workspace] [--yes]',
      '                                    按锁文件重新拉取并显示文件级差异',
      '  moss skill lock [--workspace]     校验已安装技能与锁文件是否一致',
      '',
      '编辑脚手架，补全 `description` 和正文；下次启动 moss 会自动加载（渐进披露：',
      '只有 `name` 和 `description` 进入提示词；正文由技能工具按 `{参数}` 加载）。',
      '',
      '选项：',
      '  （无）  `create` <name> 与 `list` 不接受其它参数',
      '',
      '示例：',
      '  moss skill create deploy_check',
      '  moss skill list',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss skill create <name>          scaffold .moss/skills/<name>/SKILL.md',
    '  moss skill list                   list discovered skills (workspace + user)',
    '  moss skill validate <path>        validate a skill directory against the Agent Skills spec',
    '  moss skill install <source> [--workspace] [--name n] [--yes]',
    '                                    install from a directory / git URL / npm package, write the lockfile',
    '  moss skill update [name] [--workspace] [--yes]',
    '                                    re-fetch from the lockfile and show a file-level diff',
    '  moss skill lock [--workspace]     verify installed skills still match the lockfile',
    '',
    'Edit the scaffold, fill in description + body; it appears in the next',
    'session automatically (progressive disclosure: only name + description',
    'enter the prompt; the body loads via the skill tool with {args}).',
    '',
    'Options:',
    '  (none)  create <name> and list take no other flags',
    '',
    'Examples:',
    '  moss skill create deploy-check',
    '  moss skill list',
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

  if (sub === 'install' || sub === 'update' || sub === 'lock') {
    const mod = await import('./skill-install.js');
    const installCtx = {
      workspaceDir: ctx.workspaceDir,
      configDir: ctx.configDir,
      out,
      err,
    };
    if (sub === 'install') return mod.runSkillInstall(argv.slice(1), installCtx);
    if (sub === 'update') return mod.runSkillUpdate(argv.slice(1), installCtx);
    return mod.runSkillLock(argv.slice(1), installCtx);
  }

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
        ? '编辑说明字段和正文后启动 moss——技能会自动加载。'
        : 'Edit description + body, then start moss — the skill loads automatically.'
    );
    return 0;
  }

  if (sub === 'list') {
    const { loadSkillCatalog } = await import('../core/skills/skill-registry.js');
    const { renderSkillCatalog, SKILL_CATALOG_DEFAULT_BUDGET_CHARS } =
      await import('../core/skills/skill-catalog.js');
    const { loadSkillUsage } = await import('../core/skills/skill-usage.js');
    const skills = loadSkillCatalog([
      { dir: path.join(ctx.workspaceDir, '.moss', 'skills'), scope: 'workspace' },
      { dir: path.join(ctx.workspaceDir, '.agents', 'skills'), scope: 'shared' },
      { dir: path.join(ctx.workspaceDir, '.claude', 'skills'), scope: 'shared' },
      { dir: path.join(ctx.configDir, 'skills'), scope: 'user' },
      { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'user' },
    ]);
    if (skills.length === 0) {
      out(
        zh
          ? '未发现技能。创建一个：moss skill create <名称>'
          : 'No skills found. Create one: moss skill create <name>'
      );
      return 0;
    }
    const usage = loadSkillUsage(ctx.workspaceDir);
    const total = renderSkillCatalog(skills);
    out(
      zh
        ? '  名称                来源      使用  目录成本  评测  描述'
        : '  name                scope     used  catalog   evals description'
    );
    for (const skill of skills) {
      // Per-skill catalog cost: what the full catalog entry costs for this one
      // skill (the same renderer the prompt uses, so the number is not an estimate).
      const cost = renderSkillCatalog([skill]).stats.renderedChars;
      const uses = usage[skill.name]?.count ?? 0;
      const evals = skill.resources.evals ? 'yes' : '-';
      const problems = skill.issues.length > 0 ? `  (${skill.issues.length} issue(s))` : '';
      out(
        `  ${skill.name.padEnd(18)} ${skill.scope.padEnd(9)} ${String(uses).padEnd(5)} ${String(cost).padEnd(8)} ${evals.padEnd(5)} ${skill.description.split('\n')[0] ?? ''}${problems}`
      );
    }
    out(
      zh
        ? `\n共 ${skills.length} 个技能；目录 ${total.stats.renderedChars}/${SKILL_CATALOG_DEFAULT_BUDGET_CHARS} 字符（策略 ${total.stats.strategy}，无预算上限时 ${total.stats.uncappedChars} 字符）。会话内用技能工具加载。`
        : `\n${skills.length} skill(s); catalog ${total.stats.renderedChars}/${SKILL_CATALOG_DEFAULT_BUDGET_CHARS} chars (strategy ${total.stats.strategy}, ${total.stats.uncappedChars} without a budget). Load one in-session with the skill tool.`
    );
    return 0;
  }

  if (sub === 'validate') {
    const target = argv[1];
    if (!target) {
      err(renderSkillUsage(zh));
      return 2;
    }
    const { readSkillManifest } = await import('../core/skills/skill-registry.js');
    const resolved = path.resolve(ctx.workspaceDir, target);
    const file =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? path.join(resolved, 'SKILL.md')
        : resolved;
    if (!fs.existsSync(file)) {
      err(`moss skill validate: no SKILL.md at ${file}`);
      return 2;
    }
    const parsed = readSkillManifest(file, path.basename(path.dirname(file)), 'workspace');
    if (parsed.skip) {
      err(`moss skill validate: not a loadable skill (${parsed.skip.reason}): ${file}`);
      for (const issue of parsed.issues) err(`  [${issue.code}] ${issue.message}`);
      return 1;
    }
    const skill = parsed.manifest;
    if (!skill) {
      err(`moss skill validate: could not parse ${file}`);
      return 1;
    }
    out(`${zh ? '技能' : 'skill'}: ${skill.name}`);
    out(`${zh ? '来源' : 'source'}: ${skill.scope} ${skill.dir}`);
    out(`${zh ? '符合规范' : 'spec name'}: ${skill.legacy ? 'no (legacy name)' : 'yes'}`);
    out(
      `${zh ? '描述' : 'description'}: ${skill.description.length} chars${
        skill.description.length > 1024 ? ' (over 1024)' : ''
      }`
    );
    out(`${zh ? '触发' : 'when'}: ${skill.when ?? '-'} | globs: ${skill.globs.join(', ') || '-'}`);
    out(
      `${zh ? '资源' : 'resources'}: scripts=${skill.resources.scripts.length} references=${
        skill.resources.references.length
      } assets=${skill.resources.assets.length} evals=${skill.resources.evals ? 'yes' : 'no'}`
    );
    if (skill.allowedTools.length > 0)
      out(`${zh ? '声明工具' : 'declared tools'}: ${skill.allowedTools.join(' ')}`);
    const { loadSkillEvals } = await import('../core/skills/skill-evals.js');
    const evals = loadSkillEvals(skill.dir);
    if (evals.cases.length > 0) {
      const assertable = evals.cases.filter((entry) => entry.expectContains.length > 0).length;
      out(
        `${zh ? '评测' : 'evals'}: ${String(evals.cases.length)} case(s), ${String(assertable)} with assertable expect_contains; run node scripts/skill-eval.mjs ${skill.dir}`
      );
    }
    if (skill.issues.length === 0) {
      out(zh ? '没有问题。' : 'No issues.');
      return 0;
    }
    for (const issue of skill.issues) out(`  [${issue.code}] ${issue.message}`);
    const fatal = skill.issues.some((issue) =>
      ['missing-frontmatter', 'malformed-frontmatter'].includes(issue.code)
    );
    return fatal ? 1 : 0;
  }

  err(renderSkillUsage(zh));
  return 2;
}
