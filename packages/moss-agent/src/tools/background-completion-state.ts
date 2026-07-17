/**
 * Shared queue/reported-set for background completion reminders.
 * Split out so background-exec and the reminder formatter can both
 * touch state without circular imports.
 */
import type { BackgroundProcSnapshot } from './background-exec.js';

export const backgroundCompletionReportedIds = new Set<string>();
export const backgroundCompletionPending: BackgroundProcSnapshot[] = [];

/** Whether ensureBackgroundCompletionTracker has an active lifecycle subscription. */
export let backgroundCompletionTrackerInstalled = false;

export function setBackgroundCompletionTrackerInstalled(value: boolean): void {
  backgroundCompletionTrackerInstalled = value;
}

export function clearBackgroundCompletionState(): void {
  backgroundCompletionReportedIds.clear();
  backgroundCompletionPending.length = 0;
  // clearBackgroundRegistryForTests also wipes lifecycleListeners — force
  // re-subscribe on the next ensure() so later completions are not lost.
  backgroundCompletionTrackerInstalled = false;
}

export function markBackgroundIdReported(id: string): void {
  if (!id) return;
  backgroundCompletionReportedIds.add(id);
  for (let i = backgroundCompletionPending.length - 1; i >= 0; i--) {
    if (backgroundCompletionPending[i]?.id === id) {
      backgroundCompletionPending.splice(i, 1);
    }
  }
}

export function enqueueBackgroundCompletion(snap: BackgroundProcSnapshot): void {
  if (snap.status === 'running') return;
  if (backgroundCompletionReportedIds.has(snap.id)) return;
  const idx = backgroundCompletionPending.findIndex((p) => p.id === snap.id);
  if (idx >= 0) backgroundCompletionPending[idx] = snap;
  else backgroundCompletionPending.push(snap);
}
