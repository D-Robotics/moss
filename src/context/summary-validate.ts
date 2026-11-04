/**
 * Machine check for the compaction checkpoint structure (backlog B03).
 *
 * The nine-section contract lived only in the summarization prompt: a model
 * that dropped `## 6. 设备与环境状态` (the common failure) was accepted as-is,
 * and the next compaction copied the hole forward. Cursor bounds the same risk
 * by retrying the summary with a tighter request; this module is the Moss
 * equivalent: a pure validator for the required headings plus the correction
 * instruction for the single bounded retry.
 *
 * Deliberately structural only: it checks that the ten headings exist, not
 * what they say. Content quality is the reviewer's job; this check exists so a
 * truncated/renumbered summary is never silently accepted as complete.
 */

/** Section number → canonical title, in template order. */
export const REQUIRED_SUMMARY_SECTIONS: ReadonlyMap<number, string> = new Map([
  [0, '历史脉络'],
  [1, '主要目标'],
  [2, '关键决策与约束'],
  [3, '已完成的工作'],
  [4, '当前进行中'],
  [5, '待办事项'],
  [6, '设备与环境状态'],
  [7, '关键文件与路径'],
  [8, '错误与问题'],
  [9, '后续工作所需上下文'],
]);

export interface SummaryStructureCheck {
  ok: boolean;
  /** Section numbers present (0–9). */
  found: number[];
  /** Required section numbers the summary does not mention. */
  missing: number[];
}

/** `## 6. 设备与环境状态`, `# 6 设备…`, `**6. 设备…**` all count. */
const HEADING_RE = /^\s*(?:#{1,6}\s*|\*\*\s*)(\d{1,2})\s*[.、．)]/;

export function validateSummaryStructure(summary: string): SummaryStructureCheck {
  const found = new Set<number>();
  for (const line of summary.split('\n')) {
    const match = line.match(HEADING_RE);
    if (!match) continue;
    const section = Number(match[1]);
    if (Number.isInteger(section) && REQUIRED_SUMMARY_SECTIONS.has(section)) found.add(section);
  }
  const missing = [...REQUIRED_SUMMARY_SECTIONS.keys()].filter((section) => !found.has(section));
  return {
    ok: missing.length === 0,
    found: [...found].sort((left, right) => left - right),
    missing,
  };
}

/** The one bounded retry's instruction: same content, complete structure. */
export function buildSummaryCorrectionPrompt(missing: readonly number[]): string {
  const labels = missing.map((section) => {
    const title = REQUIRED_SUMMARY_SECTIONS.get(section) ?? '';
    return `## ${section}. ${title}`;
  });
  return [
    'Correction required: the previous attempt was rejected because it is missing these required sections:',
    ...labels.map((label) => `- ${label}`),
    'Rewrite the complete summary with ALL ten sections (## 0. … ## 9.), writing「（无）」for a section with nothing to report.',
    'Compress prose to stay inside the budget — never drop a section or merge two together.',
    'Keep every user constraint, exact path, command, and error literal from the conversation.',
  ].join('\n');
}

/** Per-compaction cap: one correction, then the summary is accepted. */
export const SUMMARY_CORRECTION_ATTEMPTS = 1;
