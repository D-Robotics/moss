/**
 * `moss rules list` / `/rules` — visibility for scoped instruction rules.
 *
 * Rules were loadable but invisible: a user could not tell which `.moss/rules/*.md`
 * file is always-on, which one waits for a matching path, and which one has to
 * be requested with `@rule:<name>`. The list shows the activation class, scope,
 * globs and size so an 8 KB rule is not a surprise.
 */
import { uiText } from '../utils/ui-language.js';
import {
  loadInstructionRules,
  ruleActivation,
  ruleName,
  type InstructionRule,
} from './project-instructions.js';

export interface RuleRow {
  name: string;
  activation: 'always' | 'globs' | 'manual';
  scope: 'user' | 'workspace';
  globs: string[];
  bytes: number;
  file: string;
  description?: string;
}

const ACTIVATION_LABEL: Record<RuleRow['activation'], { en: string; zh: string }> = {
  always: { en: 'always', zh: '始终' },
  globs: { en: 'globs ', zh: '路径' },
  manual: { en: 'manual', zh: '手动' },
};

export function collectRuleRows(options: { workspaceDir: string; userDir?: string }): RuleRow[] {
  const rules = loadInstructionRules({
    workspace: options.workspaceDir,
    ...(options.userDir ? { userDir: options.userDir } : {}),
  });
  return rules.map((rule) => rowFor(rule));
}

function rowFor(rule: InstructionRule): RuleRow {
  return {
    name: ruleName(rule),
    activation: ruleActivation(rule),
    scope: rule.scope,
    globs: [...rule.globs],
    bytes: Buffer.byteLength(rule.text, 'utf8'),
    file: rule.file,
    ...(rule.description ? { description: rule.description } : {}),
  };
}

export function renderRulesUsage(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss rules list [--json]     列出 .moss/rules 与用户级 rules 的激活方式与大小',
      '',
      '三类激活：始终（无 globs/description）、路径（globs 命中时自动附加）、',
      '手动（只有 description，需在消息里写 @rule:<名称> 才注入）。',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss rules list [--json]     list scoped rules with activation class and size',
    '',
    'Classes: always (no globs/description), globs (auto-attached on a matching path),',
    'manual (description only; inject by writing @rule:<name> in a message).',
  ].join('\n');
}

/** `moss rules list [--json]`; exit 0, 2 on usage error. */
export async function runRulesCommand(
  argv: readonly string[],
  options: { workspaceDir: string; userDir?: string; zh?: boolean; json?: boolean }
): Promise<number> {
  const zh = options.zh ?? false;
  const sub = argv[0];
  if (sub !== undefined && sub !== 'list') {
    console.error(renderRulesUsage(zh));
    return 2;
  }
  const json = options.json === true || argv.includes('--json');
  const rows = collectRuleRows(options);
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema: 'moss_rules.v1', rules: rows }, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    console.error(
      uiText(
        'No scoped rules found. Add .moss/rules/<name>.md (optional globs:/description: frontmatter).',
        '未发现规则。新建 .moss/rules/<名称>.md（可选 globs:/description: frontmatter）。'
      )
    );
    return 0;
  }
  console.error(uiText('Scoped rules', '作用域规则'));
  for (const row of rows) {
    const activation = ACTIVATION_LABEL[row.activation][zh ? 'zh' : 'en'];
    const globs = row.globs.length > 0 ? ` [${row.globs.join(', ')}]` : '';
    const description = row.description ? ` — ${row.description}` : '';
    console.error(
      `  ${row.name.padEnd(16)} ${activation}  ${row.scope.padEnd(9)} ${String(row.bytes).padStart(5)}B${globs}${description}`
    );
  }
  console.error(
    uiText(
      `  (${rows.length} rule(s) · always+globs load automatically; manual needs @rule:<name>)`,
      `  （${rows.length} 条 · always+globs 自动加载；manual 需 @rule:<名称>）`
    )
  );
  return 0;
}
