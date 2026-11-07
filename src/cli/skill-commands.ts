/**
 * `moss skill create <name>` — scaffold a SKILL.md in `.moss/skills/<name>/`.
 * The template carries frontmatter hints (name/description/when) and an
 * $ARGUMENTS placeholder, so the model can call the skill with arguments the
 * moment the user edits the description.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultSkillDirSpecs } from '../core/skills/skill-registry.js';
import { isZhLocale } from './cli-locale.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function renderSkillUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss skill create <名称>          生成 .moss/skills/<名称>/SKILL.md 脚手架',
      '  moss skill list                   列出已发现的技能（工作区与用户级）',
      '  moss skill validate <名称|路径>   按 Agent Skills 规范校验一个技能（名称按发现范围解析）',
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
    '  moss skill list [--json]          list discovered skills (workspace + user)',
    '  moss skill validate <name|path>   validate a skill (a bare name is resolved via discovery scopes)',
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
    '  --json  machine-readable rows + catalog summary (skill list only)',
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
  /** Global `--json` is stripped by the arg parser; the dispatcher forwards it. */
  json?: boolean;
}

/**
 * Skills as the session sees them: scope, real usage count, per-entry catalog cost
 * (rendered by the same renderer the prompt uses), whether evals exist, and the
 * catalog budget summary. Shared by `moss skill list` and the in-session `/skills`
 * command so both surfaces report the same numbers.
 */
/**
 * B243: `/skills` printed each skill's full catalog description, so nineteen
 * skills filled the whole screen (the TUI wraps the row). The in-session panel
 * keeps one readable line; `moss skill list` keeps the full text.
 */
export function compactSkillDescription(text: string, limit = 72): string {
  const one = (text.split('\n')[0] ?? '').trim();
  if (one.length <= limit) return one;
  return `${one.slice(0, limit - 1).trimEnd()}…`;
}

/** One row of `moss skill list`, shared by the table renderer and `--json`. */
export interface SkillListRow {
  name: string;
  scope: string;
  used: number;
  /** Catalog characters this skill costs; null when it is user-only. */
  catalogChars: number | null;
  modelInvocable: boolean;
  evals: boolean;
  description: string;
  issues: string[];
}

export interface SkillListSummary {
  count: number;
  catalogChars: number;
  budgetChars: number;
  strategy: string;
  uncappedChars: number;
}

export interface SkillListData {
  rows: SkillListRow[];
  summary: SkillListSummary;
}

/**
 * B276: the data behind `moss skill list`. The table and `--json` read the same
 * rows so scripts and humans cannot disagree about counts or catalog cost.
 */
export async function loadSkillListData(
  workspaceDir: string,
  configDir: string,
  contextTokens?: number
): Promise<SkillListData | null> {
  const { loadSkillCatalog } = await import('../core/skills/skill-registry.js');
  const {
    rankSkillsForCatalog,
    renderSkillCatalog,
    skillCatalogBudgetForWindow,
    SKILL_CATALOG_DEFAULT_BUDGET_CHARS,
  } = await import('../core/skills/skill-catalog.js');
  const { loadSkillUsage } = await import('../core/skills/skill-usage.js');
  const skills = loadSkillCatalog(defaultSkillDirSpecs(workspaceDir, configDir));
  if (skills.length === 0) return null;
  const usage = loadSkillUsage(workspaceDir);
  // Same order the catalog budget uses, so the table shows which entries
  // survive a cut: scope precedence, then recently used first.
  const ranked = rankSkillsForCatalog(skills, usage);
  // `disable-model-invocation` entries are not in the model catalog: they cost
  // the model 0 chars and only appear here (and in slash completion).
  const modelSkills = skills.filter((skill) => skill.modelInvocable !== false);
  const budget =
    contextTokens === undefined
      ? SKILL_CATALOG_DEFAULT_BUDGET_CHARS
      : skillCatalogBudgetForWindow(contextTokens);
  const total = renderSkillCatalog(modelSkills, { usage, budgetChars: budget });
  const rows: SkillListRow[] = ranked.map((skill) => ({
    name: skill.name,
    scope: skill.scope,
    used: usage[skill.name]?.count ?? 0,
    // Per-skill catalog cost: what the full catalog entry costs for this one
    // skill (the same renderer the prompt uses, so the number is not an estimate).
    catalogChars:
      skill.modelInvocable !== false ? renderSkillCatalog([skill]).stats.renderedChars : null,
    modelInvocable: skill.modelInvocable !== false,
    evals: Boolean(skill.resources.evals),
    description: skill.description,
    issues: skill.issues.map((issue) => String(issue)),
  }));
  return {
    rows,
    summary: {
      count: skills.length,
      catalogChars: total.stats.renderedChars,
      budgetChars: budget,
      strategy: total.stats.strategy,
      uncappedChars: total.stats.uncappedChars,
    },
  };
}

export async function renderSkillsList(
  workspaceDir: string,
  configDir: string,
  zh: boolean = isZhLocale(),
  /** Model context window; the in-session budget is ~1% of it (8k fallback). */
  contextTokens?: number,
  options: { compact?: boolean } = {}
): Promise<string> {
  const data = await loadSkillListData(workspaceDir, configDir, contextTokens);
  if (!data) {
    return zh
      ? '未发现技能。创建一个：moss skill create <名称>'
      : 'No skills found. Create one: moss skill create <name>';
  }
  const { rows, summary } = data;
  const lines: string[] = [
    zh
      ? '  名称                来源      使用  目录成本  评测  描述'
      : '  name                scope     used  catalog   evals description',
  ];
  for (const row of rows) {
    const cost = row.modelInvocable ? String(row.catalogChars ?? 0) : 'user-only';
    const evals = row.evals ? 'yes' : '-';
    const problems = row.issues.length > 0 ? `  (${row.issues.length} issue(s))` : '';
    const description =
      options.compact === true
        ? compactSkillDescription(row.description)
        : (row.description.split('\n')[0] ?? '');
    lines.push(
      `  ${row.name.padEnd(18)} ${row.scope.padEnd(9)} ${String(row.used).padEnd(5)} ${cost.padEnd(8)} ${evals.padEnd(5)} ${description}${problems}`
    );
  }
  lines.push(
    zh
      ? `\n共 ${summary.count} 个技能；目录 ${summary.catalogChars}/${summary.budgetChars} 字符（策略 ${summary.strategy}，无预算上限时 ${summary.uncappedChars} 字符）。会话内用技能工具加载；\`user-only\` 技能仅用户可用（disable-model-invocation），不占目录字符。`
      : `\n${summary.count} skill${summary.count === 1 ? '' : 's'}; catalog ${summary.catalogChars}/${summary.budgetChars} chars (strategy ${summary.strategy}, ${summary.uncappedChars} without a budget). Load one in-session with the skill tool. \`user-only\` skills are user-invocable only (disable-model-invocation) and never cost catalog chars.`
  );
  return lines.join('\n');
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
    const json = ctx.json === true || argv.includes('--json');
    if (json) {
      const data = await loadSkillListData(ctx.workspaceDir, ctx.configDir);
      out(
        JSON.stringify({ schema: 'moss_skill_list.v1', ...(data ?? { rows: [], summary: null }) })
      );
      return 0;
    }
    // B275: the human table truncates one description line, not the whole
    // multiline body; a 300-char description turned one row into a paragraph.
    out(await renderSkillsList(ctx.workspaceDir, ctx.configDir, zh, undefined, { compact: true }));
    return 0;
  }

  if (sub === 'validate') {
    const target = argv[1];
    // B320: editors/CI want the report structurally, not as prose.
    const validateJson = ctx.json === true || argv.includes('--json');
    const emitValidateJson = (payload: Record<string, unknown>): void => {
      out(JSON.stringify({ schema: 'moss_skill_validate.v1', target: target ?? '', ...payload }));
    };
    if (!target) {
      if (validateJson) emitValidateJson({ ok: false, error: 'no-target' });
      else err(renderSkillUsage(zh));
      return 2;
    }
    const { readSkillManifest, loadSkillCatalog } =
      await import('../core/skills/skill-registry.js');
    const resolved = path.resolve(ctx.workspaceDir, target);
    let file =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? path.join(resolved, 'SKILL.md')
        : resolved;
    // `/skills` tells the user to run `moss skill validate <name>`, and a skill
    // can live in a user-level dir that is nowhere near the workspace, so a bare
    // name is resolved through the same discovery scopes the runtime uses
    // (workspace → shared conventions → user-level) instead of failing with
    // "no SKILL.md at <workspace>/<name>".
    if (!fs.existsSync(file) && !target.includes(path.sep) && !target.includes('/')) {
      const dirs = defaultSkillDirSpecs(ctx.workspaceDir, ctx.configDir);
      const found = loadSkillCatalog(dirs).find((skill) => skill.name === target);
      if (found) file = path.join(found.dir, 'SKILL.md');
      else {
        // B303: an invalid skill is skipped by the catalog, so a bare name could
        // not reach its own validation report. Try the conventional scoped
        // locations before saying "no skill named".
        const direct = dirs
          .map((entry) => path.join(entry.dir, target, 'SKILL.md'))
          .find((candidate) => fs.existsSync(candidate));
        if (direct) file = direct;
      }
      if (!fs.existsSync(file)) {
        if (validateJson) {
          emitValidateJson({ ok: false, error: 'not-found', searched: dirs });
        } else {
          err(`moss skill validate: no skill named "${target}" in:`);
          for (const d of dirs) err(`  ${d.dir} (${d.scope})`);
          err('Pass a path instead if the skill lives somewhere else.');
        }
        return 2;
      }
    }
    if (!fs.existsSync(file)) {
      if (validateJson) emitValidateJson({ ok: false, error: 'missing-file', file });
      else err(`moss skill validate: no SKILL.md at ${file}`);
      return 2;
    }
    const parsed = readSkillManifest(file, path.basename(path.dirname(file)), 'workspace');
    if (parsed.skip) {
      if (validateJson) {
        emitValidateJson({
          ok: false,
          error: 'skipped',
          file,
          skip: {
            reason: parsed.skip.reason,
            ...(parsed.skip.detail ? { detail: parsed.skip.detail } : {}),
          },
          issues: parsed.issues,
        });
      } else {
        err(`moss skill validate: not a loadable skill (${parsed.skip.reason}): ${file}`);
        if (parsed.skip.detail) err(`  ${parsed.skip.detail}`);
        for (const issue of parsed.issues) err(`  [${issue.code}] ${issue.message}`);
      }
      return 1;
    }
    const skill = parsed.manifest;
    if (!skill) {
      if (validateJson) emitValidateJson({ ok: false, error: 'unparseable', file });
      else err(`moss skill validate: could not parse ${file}`);
      return 1;
    }
    if (validateJson) {
      const { loadSkillEvals } = await import('../core/skills/skill-evals.js');
      const evals = loadSkillEvals(skill.dir);
      emitValidateJson({
        ok: true,
        file,
        skill: {
          name: skill.name,
          scope: skill.scope,
          dir: skill.dir,
          legacyName: skill.legacy === true,
          descriptionChars: skill.description.length,
          when: skill.when ?? null,
          globs: [...skill.globs],
          resources: {
            scripts: skill.resources.scripts.length,
            references: skill.resources.references.length,
            assets: skill.resources.assets.length,
            evals: Boolean(skill.resources.evals),
          },
          allowedTools: [...skill.allowedTools],
          issues: skill.issues,
          evals: { cases: evals.cases.length },
        },
      });
      return 0;
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
