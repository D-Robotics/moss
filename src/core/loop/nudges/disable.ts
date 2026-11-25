/**
 * Experiment switch for the loop's harness-injected turns.
 *
 * `MOSS_DISABLE_NUDGES=id1,id2` suppresses those injections for the process.
 * Unset, empty, or whitespace-only leaves them on. Unknown ids are ignored by
 * call sites (they simply never match). Ids are case-sensitive.
 *
 * What remains under this switch is recovery from a structural provider fact
 * (output-limit stop, reasoning-only turn, empty response, truncated tool JSON)
 * and the completion gates. The rule-based nudges that read the model's prose
 * with regexes, the steering rule engine, and the follow-up guard were removed
 * on 2026-11-26: the model decides how to work, the harness only reports facts.
 *
 * The dev bench copies this variable into the child Moss environment when
 * the parent set it (`scripts/run-benchmark.mjs`). This module reads only
 * the environment object it is given.
 */
export const MOSS_DISABLE_NUDGES_ENV = 'MOSS_DISABLE_NUDGES';

/** Stable ablation ids. The shell soft-failure appendix lives in frozen `src/safety/**` and is intentionally absent: naming it here would not disable it. */
export const NUDGE_IDS = [
  'reasoning-only',
  'output-continuation',
  'empty-response',
  'truncated-tool-json',
  'background-completion',
  'background-lifecycle-gate',
  'acceptance-gate',
] as const;

export type NudgeId = (typeof NUDGE_IDS)[number];

/** Split a comma list. Empty pieces are dropped. The set may contain unknown ids. */
export function parseDisabledNudgeIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw || !raw.trim()) return EMPTY_IDS;
  const ids = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id) ids.add(id);
  }
  return ids.size === 0 ? EMPTY_IDS : ids;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** Raw disable list. A missing key and an empty value both leave every nudge on. */
export function resolveDisabledNudgeRaw(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[MOSS_DISABLE_NUDGES_ENV];
}

export function disabledNudgeIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return parseDisabledNudgeIds(resolveDisabledNudgeRaw(env));
}

export function isNudgeDisabled(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return disabledNudgeIds(env).has(id);
}
