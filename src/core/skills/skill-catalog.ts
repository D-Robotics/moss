/**
 * Skill catalog rendering: the L1 tier of progressive disclosure.
 *
 * The catalog is re-sent on every turn (it lives in a dynamic prompt layer), so
 * its size is rent. With one line per skill and no cap, an installed library
 * silently grows the per-turn prompt — the reason Cursor's renderer reports
 * rendered/uncapped tokens, omitted count and a strategy. This module does the
 * same thing deterministically:
 *
 *   full       — description (up to 200 chars) + when
 *   compact    — description (up to 120 chars) + when
 *   name-only  — `- name` lines only
 *   mixed      — name-only entries in ranked order until the budget is used,
 *                the rest are omitted and counted
 *
 * Uncertainty is surfaced, not hidden: `stats` carries `uncappedChars`,
 * `omitted`, `truncatedDescriptions` and the chosen `strategy`.
 */
import type { SkillManifest, SkillScope } from '../../contracts/skill.js';
import type { SkillUsage } from './skill-usage.js';

/** Total characters the catalog may take in one prompt. Env-overridable by the host. */
export const SKILL_CATALOG_DEFAULT_BUDGET_CHARS = 8_000;
/**
 * Claude parity: the L1 listing may take ~1% of the model's context window,
 * expressed as characters (≈4 chars/token), with the 8,000-char fallback as the
 * ceiling and a readable floor for tiny windows.
 *
 * The 8,000-char fallback is therefore exactly 1% of a 200k-token window: on a
 * small window a fixed 8,000-char catalog would cost several times the share the
 * reference products budget for it (a 32k window would spend ~25% of the
 * prompt on skill names) and crowd out history.
 */
export const SKILL_CATALOG_WINDOW_SHARE = 0.01;
export const SKILL_CATALOG_CHARS_PER_TOKEN = 4;
export const SKILL_CATALOG_BUDGET_FLOOR_CHARS = 800;

/** Budget in characters for a known context window; the default when unknown. */
export function skillCatalogBudgetForWindow(contextTokens?: number): number {
  if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return SKILL_CATALOG_DEFAULT_BUDGET_CHARS;
  }
  const chars = Math.round(
    contextTokens * SKILL_CATALOG_WINDOW_SHARE * SKILL_CATALOG_CHARS_PER_TOKEN
  );
  return Math.min(
    SKILL_CATALOG_DEFAULT_BUDGET_CHARS,
    Math.max(SKILL_CATALOG_BUDGET_FLOOR_CHARS, chars)
  );
}
export const SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 200;
export const SKILL_CATALOG_DESCRIPTION_COMPACT_CHARS = 120;
/**
 * Ceilings for the rest of one entry. Claude Code's disclosure budget caps a
 * skill entry at ~1,536 chars; without an equivalent, one skill whose `when`
 * text is a paragraph could take a fifth of Moss's 8,000-char catalog and push
 * other skills into name-only mode. Descriptions were already clipped; `when`
 * and the composed line were not.
 */
export const SKILL_CATALOG_WHEN_MAX_CHARS = 240;
export const SKILL_CATALOG_ENTRY_MAX_CHARS = 1_536;

export type SkillCatalogStrategy = 'full' | 'compact' | 'name-only' | 'mixed';

export interface SkillCatalogStats {
  skills: number;
  renderedChars: number;
  /** What the same catalog would cost with full descriptions and no budget. */
  uncappedChars: number;
  omitted: number;
  truncatedDescriptions: number;
  strategy: SkillCatalogStrategy;
  /** True when at least one skill had recorded use and the order reflects it. */
  usageAware: boolean;
}

export interface SkillCatalogResult {
  /** Undefined when there are no skills. */
  text?: string;
  stats: SkillCatalogStats;
}

export interface SkillCatalogOptions {
  budgetChars?: number;
  /**
   * Local use counters (`.moss/skills-usage.json`). When present, entries a
   * session actually loaded rank before unused ones inside their scope, most
   * recent first — the least-recently-used skill is the first to lose its
   * description or be omitted, instead of whichever name sorts first.
   */
  usage?: SkillUsage;
}

const SCOPE_RANK: Record<SkillScope, number> = {
  workspace: 0,
  shared: 1,
  bundled: 2,
  user: 3,
};

const HEADER = [
  '## Available skills',
  'Load a skill body on demand with the `skill` tool (input: {"name": "..."}).',
];

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const collapsed = collapse(text);
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Scope precedence is a declared contract and stays the primary key; usage only
 * orders entries *inside* a scope. Used entries come first (most recent load
 * first, then by count), unused ones follow alphabetically. Without usage this
 * is exactly the old scope-then-name order.
 */
function catalogsInRankOrder(
  skills: readonly SkillManifest[],
  usage: SkillUsage | undefined
): SkillManifest[] {
  return [...skills].sort((a, b) => {
    const byScope = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    if (byScope !== 0) return byScope;
    const aUse = usage?.[a.name];
    const bUse = usage?.[b.name];
    if (aUse && !bUse) return -1;
    if (!aUse && bUse) return 1;
    if (aUse && bUse) {
      const byTime = (bUse.lastUsedAt ?? '').localeCompare(aUse.lastUsedAt ?? '');
      if (byTime !== 0) return byTime;
      const byCount = (bUse.count ?? 0) - (aUse.count ?? 0);
      if (byCount !== 0) return byCount;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Catalog rank order (scope precedence, then usage, then name). */
export function rankSkillsForCatalog(
  skills: readonly SkillManifest[],
  usage?: SkillUsage
): SkillManifest[] {
  return catalogsInRankOrder(skills, usage);
}

function hasUsage(usage: SkillUsage | undefined, skills: readonly SkillManifest[]): boolean {
  if (!usage) return false;
  return skills.some((skill) => usage[skill.name] !== undefined);
}

function renderEntry(skill: SkillManifest, mode: 'full' | 'compact' | 'name-only'): string {
  if (mode === 'name-only') return `- ${skill.name}`;
  const max =
    mode === 'compact'
      ? SKILL_CATALOG_DESCRIPTION_COMPACT_CHARS
      : SKILL_CATALOG_DESCRIPTION_MAX_CHARS;
  const description = clip(skill.description, max);
  const whenText = skill.when ? clip(skill.when, SKILL_CATALOG_WHEN_MAX_CHARS) : '';
  const when = whenText ? ` (when: ${whenText})` : '';
  const line = `- ${skill.name}: ${description}${when}`;
  if (line.length <= SKILL_CATALOG_ENTRY_MAX_CHARS) return line;
  // Last-resort ceiling: a pathological name or description cannot exceed one
  // entry's share of the budget.
  return `${line.slice(0, SKILL_CATALOG_ENTRY_MAX_CHARS - 1).trimEnd()}…`;
}

function renderText(lines: readonly string[]): string {
  return [...HEADER, ...lines].join('\n');
}

function countTruncated(
  skills: readonly SkillManifest[],
  mode: 'full' | 'compact' | 'name-only'
): number {
  if (mode === 'name-only') return 0;
  const max =
    mode === 'compact'
      ? SKILL_CATALOG_DESCRIPTION_COMPACT_CHARS
      : SKILL_CATALOG_DESCRIPTION_MAX_CHARS;
  return skills.filter((skill) => collapse(skill.description).length > max).length;
}

/**
 * Render the L1 catalog under a character budget. Deterministic for a given
 * skill list: ranking is scope then name, and the degradation ladder is fixed.
 */
export function renderSkillCatalog(
  skills: readonly SkillManifest[],
  options: SkillCatalogOptions = {}
): SkillCatalogResult {
  const budget = options.budgetChars ?? SKILL_CATALOG_DEFAULT_BUDGET_CHARS;
  const usageAware = hasUsage(options.usage, skills);
  if (skills.length === 0) {
    return {
      stats: {
        skills: 0,
        renderedChars: 0,
        uncappedChars: 0,
        omitted: 0,
        truncatedDescriptions: 0,
        strategy: 'full',
        usageAware: false,
      },
    };
  }
  const ranked = rankSkillsForCatalog(skills, options.usage);
  const uncapped = renderText(skills.map((skill) => renderEntry(skill, 'full'))).length;

  for (const mode of ['full', 'compact'] as const) {
    const text = renderText(ranked.map((skill) => renderEntry(skill, mode)));
    if (text.length <= budget) {
      return {
        text,
        stats: {
          skills: skills.length,
          renderedChars: text.length,
          uncappedChars: uncapped,
          omitted: 0,
          truncatedDescriptions: countTruncated(ranked, mode),
          strategy: mode,
          usageAware,
        },
      };
    }
  }

  // Mixed: first guarantee a name-only baseline (coverage beats detail), then
  // spend the remaining budget upgrading entries to their richest fit line in
  // ranked order. Omission only happens when even name-only lines do not fit.
  const headerCost = renderText([]).length;
  const nameOnlyLines = ranked.map((skill) => renderEntry(skill, 'name-only'));
  const baseline = nameOnlyLines.reduce((sum, line) => sum + line.length + 1, headerCost);
  const kept: string[] = [];
  let used = headerCost;
  let omitted = 0;
  let truncatedDescriptions = 0;
  if (baseline > budget) {
    for (const line of nameOnlyLines) {
      if (used + line.length + 1 > budget) {
        omitted += 1;
        continue;
      }
      kept.push(line);
      used += line.length + 1;
    }
  } else {
    const upgradeBudget = budget - baseline;
    let remaining = upgradeBudget;
    for (let i = 0; i < ranked.length; i += 1) {
      const skill = ranked[i] as SkillManifest;
      const nameOnly = nameOnlyLines[i] as string;
      let chosen = nameOnly;
      for (const mode of ['full', 'compact'] as const) {
        const line = renderEntry(skill, mode);
        const delta = line.length - nameOnly.length;
        if (delta <= remaining) {
          chosen = line;
          remaining -= delta;
          const width =
            mode === 'full'
              ? SKILL_CATALOG_DESCRIPTION_MAX_CHARS
              : SKILL_CATALOG_DESCRIPTION_COMPACT_CHARS;
          if (collapse(skill.description).length > width) truncatedDescriptions += 1;
          break;
        }
      }
      kept.push(chosen);
      used += chosen.length + 1;
    }
  }
  const buildNotice = (count: number) =>
    count > 0 ? `…${count} more skill(s) hidden by the catalog budget` : '';
  let text = renderText(omitted > 0 ? [...kept, buildNotice(omitted)] : kept);
  // The hidden-skills notice is part of the budget; drop lines until it fits.
  while (text.length > budget && kept.length > 0) {
    kept.pop();
    omitted += 1;
    text = renderText([...kept, buildNotice(omitted)]);
  }
  if (kept.length === 0 && text.length > budget) {
    text = renderText([]);
  }
  const keptAnyDescription = kept.some((line) => line.startsWith('- ') && line.includes(': '));
  return {
    text,
    stats: {
      skills: skills.length,
      renderedChars: text.length,
      uncappedChars: uncapped,
      omitted,
      truncatedDescriptions,
      strategy: keptAnyDescription ? 'mixed' : 'name-only',
      usageAware,
    },
  };
}
