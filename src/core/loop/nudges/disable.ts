/**
 * Experiment switch for loop nudges.
 *
 * `MOSS_DISABLE_NUDGES=id1,id2` suppresses those injections for the process.
 * Unset, empty, or whitespace-only leaves every nudge on. Unknown ids are
 * ignored by call sites (they simply never match). Ids are case-sensitive.
 *
 * The dev bench copies this variable into the child Moss environment when
 * the parent set it (`scripts/run-benchmark.mjs`). This module reads only
 * the environment object it is given.
 */
export const MOSS_DISABLE_NUDGES_ENV = 'MOSS_DISABLE_NUDGES';

/**
 * Stable ablation ids. Registry order matches `collectNudgeInjections`.
 * The shell soft-failure appendix lives in frozen `src/safety/**` and is
 * intentionally absent: naming it here would not disable it.
 */
export const NUDGE_IDS = [
  'todo',
  'verify',
  'red-verify',
  'fan-out',
  'ambiguity',
  'subagent-running',
  'subagent-stopped',
  'web-tools',
  'git-tools',
  'install-tools',
  'run-tests',
  'build-tools',
  'background-server',
  'task-repair',
  'reasoning-only',
  'output-continuation',
  'missing-tool-call',
  'empty-response',
  'steering-error-recovery',
  'steering-local-exploration-loop',
  'steering-web-search-variation',
  'steering-tool-loop',
  'steering-context-pressure',
  'background-completion',
  'acceptance-gate',
  'follow-up-guard',
  'truncated-tool-json',
  'goal-acceptance',
] as const;

export type NudgeId = (typeof NUDGE_IDS)[number];

const KNOWN_NUDGE_IDS: ReadonlySet<string> = new Set(NUDGE_IDS);

export function isKnownNudgeId(id: string): id is NudgeId {
  return KNOWN_NUDGE_IDS.has(id);
}

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
