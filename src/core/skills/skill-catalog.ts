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

/** Total characters the catalog may take in one prompt. Env-overridable by the host. */
export const SKILL_CATALOG_DEFAULT_BUDGET_CHARS = 8_000;
export const SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 200;
export const SKILL_CATALOG_DESCRIPTION_COMPACT_CHARS = 120;

export type SkillCatalogStrategy = 'full' | 'compact' | 'name-only' | 'mixed';

export interface SkillCatalogStats {
  skills: number;
  renderedChars: number;
  /** What the same catalog would cost with full descriptions and no budget. */
  uncappedChars: number;
  omitted: number;
  truncatedDescriptions: number;
  strategy: SkillCatalogStrategy;
}

export interface SkillCatalogResult {
  /** Undefined when there are no skills. */
  text?: string;
  stats: SkillCatalogStats;
}

export interface SkillCatalogOptions {
  budgetChars?: number;
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

function catalogsInRankOrder(skills: readonly SkillManifest[]): SkillManifest[] {
  return [...skills].sort(
    (a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || a.name.localeCompare(b.name)
  );
}

function renderEntry(skill: SkillManifest, mode: 'full' | 'compact' | 'name-only'): string {
  if (mode === 'name-only') return `- ${skill.name}`;
  const max =
    mode === 'compact'
      ? SKILL_CATALOG_DESCRIPTION_COMPACT_CHARS
      : SKILL_CATALOG_DESCRIPTION_MAX_CHARS;
  const description = clip(skill.description, max);
  const when = skill.when ? ` (when: ${collapse(skill.when)})` : '';
  return `- ${skill.name}: ${description}${when}`;
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
  if (skills.length === 0) {
    return {
      stats: {
        skills: 0,
        renderedChars: 0,
        uncappedChars: 0,
        omitted: 0,
        truncatedDescriptions: 0,
        strategy: 'full',
      },
    };
  }
  const ranked = catalogsInRankOrder(skills);
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
    },
  };
}
