/**
 * Context epoch — a stable system-context baseline with incremental reconciliation.
 *
 * The model's system context is assembled from independently-observed *sources*
 * (environment facts, date, ambient instructions, available-skill guidance, …).
 * A naive approach re-renders the whole system prompt every turn, which both
 * busts the provider's prompt cache and discards provider-native reasoning that
 * depends on a stable prefix.
 *
 * A context epoch fixes one immutable `baseline` (the exact joined text used as
 * the provider-cache prefix) plus a `snapshot` of the source values last admitted.
 * When a source changes mid-conversation, `reconcile` does NOT rewrite the
 * baseline — it emits one chronological "system update" message describing the
 * newly-effective values and advances the snapshot. The baseline only changes at
 * an epoch boundary (a fresh `initialize`/`replace`, e.g. after compaction).
 *
 * This mirrors the opencode V2 Context Epoch contract, adapted to moss's
 * string-rendered system context.
 */

/** Source key → its currently rendered value. A missing key means the source is absent. */
export type ContextSources = Readonly<Record<string, string>>;

export interface ContextSnapshot {
  readonly values: Readonly<Record<string, string>>;
}

export interface ContextEpoch {
  /** Immutable system-context text used as the provider-cache prefix for this epoch. */
  readonly baseline: string;
  /** Sequence at which this epoch began (a fresh baseline boundary). */
  readonly baselineSeq: number;
  /** Model-hidden record of the source values last admitted to the conversation. */
  readonly snapshot: ContextSnapshot;
}

export type ReconcileResult =
  | { readonly type: 'unchanged' }
  | { readonly type: 'updated'; readonly message: string; readonly snapshot: ContextSnapshot };

/** Deterministic baseline rendering: `key: value` lines in stable key order. */
function renderBaseline(sources: ContextSources): string {
  return Object.keys(sources)
    .sort()
    .map((key) => `${key}: ${sources[key]}`)
    .join('\n');
}

/** Begin an epoch: capture the immutable baseline and the initial source snapshot. */
export function initializeEpoch(sources: ContextSources, baselineSeq: number): ContextEpoch {
  return { baseline: renderBaseline(sources), baselineSeq, snapshot: { values: { ...sources } } };
}

/**
 * Render a fresh epoch baseline from current sources after a baseline-replacing
 * transition (completed compaction, session move). Distinct from `initializeEpoch`
 * only in intent; both start a new immutable baseline.
 */
export function replaceEpoch(sources: ContextSources, baselineSeq: number): ContextEpoch {
  return initializeEpoch(sources, baselineSeq);
}

/**
 * Compare current sources to the epoch snapshot. Returns `unchanged`, or one
 * chronological system message naming every newly-effective / removed source plus
 * the advanced snapshot. The epoch baseline is never mutated here.
 */
export function reconcileEpoch(epoch: ContextEpoch, current: ContextSources): ReconcileResult {
  const previous = epoch.snapshot.values;
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  const lines: string[] = [];
  for (const key of keys) {
    const before = previous[key];
    const after = current[key];
    if (before === after) continue;
    if (after === undefined) lines.push(`${key} is no longer in effect.`);
    else lines.push(`${key} is now: ${after}`);
  }
  if (lines.length === 0) return { type: 'unchanged' };
  return {
    type: 'updated',
    message: ['Updated context:', ...lines].join('\n'),
    snapshot: { values: { ...current } },
  };
}
