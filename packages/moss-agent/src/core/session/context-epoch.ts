




















export type ContextSources = Readonly<Record<string, string>>;

export interface ContextSnapshot {
  readonly values: Readonly<Record<string, string>>;
}

export interface ContextEpoch {
  
  readonly baseline: string;
  
  readonly baselineSeq: number;
  
  readonly snapshot: ContextSnapshot;
}

export type ReconcileResult =
  | { readonly type: 'unchanged' }
  | { readonly type: 'updated'; readonly message: string; readonly snapshot: ContextSnapshot };


function renderBaseline(sources: ContextSources): string {
  return Object.keys(sources)
    .sort()
    .map((key) => `${key}: ${sources[key]}`)
    .join('\n');
}


export function initializeEpoch(sources: ContextSources, baselineSeq: number): ContextEpoch {
  return { baseline: renderBaseline(sources), baselineSeq, snapshot: { values: { ...sources } } };
}






export function replaceEpoch(sources: ContextSources, baselineSeq: number): ContextEpoch {
  return initializeEpoch(sources, baselineSeq);
}






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
