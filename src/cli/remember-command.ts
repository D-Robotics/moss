/**
 * D6 `/remember <fact>` — the explicit memory write path.
 *
 * Scope is deliberately narrow (owner-authorized 2026-11-04): no automatic
 * memory. One fact at a time, written to the workspace `AGENTS.md` (the file
 * Moss already loads as project instructions, so a new session sees it), with
 * a diff preview, de-duplication, and an easy undo (`git checkout AGENTS.md` or
 * delete the line). Nothing is written when the fact is already recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { uiText } from '../utils/ui-language.js';

export const REMEMBERED_FACTS_HEADING = '## Remembered facts';

const FACT_MAX_CHARS = 500;

export interface RememberPlan {
  file: string;
  fact: string;
  previousText: string;
  nextText: string;
  /** False when the fact is already present (or blank): nothing to write. */
  changed: boolean;
  /** True when the plan has to add the section heading. */
  createdSection: boolean;
}

export interface RememberArgs {
  fact: string;
  dryRun: boolean;
}

/** Parse `moss remember "<fact>" [--dry-run]`; the fact may span several args. */
export function parseRememberArgs(argv: readonly string[]): RememberArgs {
  const words: string[] = [];
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true;
    else if (arg.startsWith('--')) continue;
    else words.push(arg);
  }
  return { fact: words.join(' ').trim(), dryRun };
}

/** Collapse whitespace so "Use  npm run verify" and "use npm run verify" dedupe. */
function normalizeFact(fact: string): string {
  return fact.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildRememberPlan(
  workspaceDir: string,
  fact: string
): RememberPlan | { error: string } {
  const trimmed = fact.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return { error: uiText('the fact is empty', '要记住的内容为空') };
  if (trimmed.length > FACT_MAX_CHARS) {
    return {
      error: uiText(
        `the fact is ${trimmed.length} chars; keep it under ${FACT_MAX_CHARS}`,
        `内容有 ${trimmed.length} 字符，请控制在 ${FACT_MAX_CHARS} 以内`
      ),
    };
  }
  const file = path.join(workspaceDir, 'AGENTS.md');
  let previousText = '';
  try {
    previousText = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        error: uiText(
          `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
          `无法读取 ${file}：${error instanceof Error ? error.message : String(error)}`
        ),
      };
    }
  }
  const lines = previousText === '' ? [] : previousText.split('\n');
  const normalized = normalizeFact(trimmed);
  const already = lines.some((line) => {
    const match = /^\s*[-*]\s+(.*)$/.exec(line);
    return match ? normalizeFact(match[1] ?? '') === normalized : false;
  });
  if (already) {
    return {
      file,
      fact: trimmed,
      previousText,
      nextText: previousText,
      changed: false,
      createdSection: false,
    };
  }
  const headingIndex = lines.findIndex((line) => line.trim() === REMEMBERED_FACTS_HEADING);
  const createdSection = headingIndex === -1;
  let nextText: string;
  if (createdSection) {
    const base = previousText === '' ? '' : previousText.replace(/\s*$/, '\n\n');
    nextText = `${base}${REMEMBERED_FACTS_HEADING}\n\n- ${trimmed}\n`;
  } else {
    // Insert as the last bullet of the existing section: walk to the next heading.
    let insertAt = headingIndex + 1;
    let lastBullet = headingIndex;
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim().startsWith('## ')) break;
      insertAt = i + 1;
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) lastBullet = i;
    }
    const target = lastBullet === headingIndex ? headingIndex + 1 : lastBullet + 1;
    const insertLine = target;
    const before = lines.slice(0, insertLine);
    const after = lines.slice(insertLine);
    // Keep a blank line between the heading and its first bullet.
    if (lastBullet === headingIndex && (before[before.length - 1] ?? '').trim() !== '') {
      nextText = [...before, '', `- ${trimmed}`, ...after].join('\n');
    } else {
      nextText = [...before, `- ${trimmed}`, ...after].join('\n');
    }
    void insertAt;
  }
  return { file, fact: trimmed, previousText, nextText, changed: true, createdSection };
}

/** Human-readable preview: the file, the new fact, and the added line. */
export function renderRememberPreview(plan: RememberPlan): string {
  const relative = path.basename(plan.file);
  if (!plan.changed) {
    return uiText(
      `Already remembered in ${relative}: ${plan.fact}`,
      `${relative} 里已经记过：${plan.fact}`
    );
  }
  return [
    uiText(`Would add to ${relative}:`, `将写入 ${relative}：`),
    `  + - ${plan.fact}`,
    plan.createdSection
      ? uiText(
          `  (creates the "${REMEMBERED_FACTS_HEADING}" section)`,
          `  （新建「${REMEMBERED_FACTS_HEADING}」小节）`
        )
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Write the plan. Refuses to clobber a file that changed since the plan was built. */
export function applyRememberPlan(plan: RememberPlan): { ok: true } | { ok: false; error: string } {
  if (!plan.changed) return { ok: true };
  try {
    const current = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : '';
    if (current !== plan.previousText) {
      return {
        ok: false,
        error: uiText(
          `${plan.file} changed while the fact was being prepared; run /remember again`,
          `${plan.file} 在准备写入期间被改动，请重新执行 /remember`
        ),
      };
    }
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    fs.writeFileSync(plan.file, plan.nextText, 'utf8');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: uiText(
        `could not write ${plan.file}: ${error instanceof Error ? error.message : String(error)}`,
        `无法写入 ${plan.file}：${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
}

export function renderRememberUsage(): string {
  return [
    uiText('Usage:', '用法：'),
    uiText(
      '  moss remember "<fact>"            append one fact to AGENTS.md',
      '  moss remember "<事实>"            追加一条事实到 AGENTS.md'
    ),
    uiText(
      '  moss remember "<fact>" --dry-run preview only, write nothing',
      '  moss remember "<事实>" --dry-run  只预览，不写入'
    ),
    '',
    uiText(
      'Explicit only: nothing is remembered automatically. Review with `git diff AGENTS.md`; undo by deleting the line.',
      '只做显式写入：不会自动记忆。用 `git diff AGENTS.md` 审查；删掉那一行即可撤销。'
    ),
  ].join('\n');
}

/** `moss remember "<fact>" [--dry-run]` — exit 0 written/known, 2 usage. */
export async function runRememberCommand(
  argv: readonly string[],
  options: { workspaceDir: string; zh?: boolean }
): Promise<number> {
  const args = parseRememberArgs(argv);
  if (args.fact === '' || argv.includes('--help') || argv.includes('-h')) {
    console.error(renderRememberUsage());
    return 2;
  }
  const plan = buildRememberPlan(options.workspaceDir, args.fact);
  if ('error' in plan) {
    console.error(`moss remember: ${plan.error}`);
    return 2;
  }
  console.error(renderRememberPreview(plan));
  if (!plan.changed) return 0;
  if (args.dryRun) return 0;
  const applied = applyRememberPlan(plan);
  if (!applied.ok) {
    console.error(`moss remember: ${applied.error}`);
    return 1;
  }
  console.error(
    uiText(
      `Wrote ${plan.file}. Review with \`git diff AGENTS.md\`; a new session loads it automatically.`,
      `已写入 ${plan.file}。用 \`git diff AGENTS.md\` 审查；新会话会自动加载。`
    )
  );
  return 0;
}
