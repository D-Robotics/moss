/**
 * Background-command completion reminders (Grok TaskCompletionReminder parity).
 *
 * The exec tool description promises "You will be notified when a background
 * command finishes". Lifecycle listeners existed for the TUI, but nothing
 * injected model-visible context — so coding agents that start a test/build
 * in the background never learned when it finished unless they polled
 * exec_logs. This module is the missing reader.
 */
import {
  getBackgroundProcessOutputTail,
  getBackgroundProcessSnapshot,
  subscribeBackgroundLifecycle,
  type BackgroundProcSnapshot,
} from './background-exec.js';
import {
  backgroundCompletionPending,
  backgroundCompletionReportedIds,
  backgroundCompletionTrackerInstalled,
  clearBackgroundCompletionState,
  enqueueBackgroundCompletion,
  markBackgroundIdReported,
  setBackgroundCompletionTrackerInstalled,
} from './background-completion-state.js';

const MAX_TAIL_LINES = 40;
const MAX_REMINDER_CHARS = 4_000;

let unsubscribeLifecycle: (() => void) | null = null;

/** Exported for tests — reset tracker state without killing processes. */
export function clearBackgroundCompletionReminderForTests(): void {
  if (unsubscribeLifecycle) {
    try {
      unsubscribeLifecycle();
    } catch {
      /* ignore */
    }
    unsubscribeLifecycle = null;
  }
  clearBackgroundCompletionState();
}

/**
 * Mark an id as already surfaced (e.g. start tool result already included
 * an immediate exit). Prevents a duplicate system-reminder on the next drain.
 */
export function markBackgroundCompletionReported(id: string): void {
  markBackgroundIdReported(id);
}

/**
 * Install the process-level lifecycle subscriber (idempotent).
 * Call once per agent-loop run (or once per process — safe either way).
 * Re-installs after clearBackgroundRegistryForTests / clearBackgroundCompletionState.
 */
export function ensureBackgroundCompletionTracker(): void {
  if (backgroundCompletionTrackerInstalled && unsubscribeLifecycle) return;
  if (unsubscribeLifecycle) {
    try {
      unsubscribeLifecycle();
    } catch {
      /* ignore */
    }
    unsubscribeLifecycle = null;
  }
  setBackgroundCompletionTrackerInstalled(true);
  unsubscribeLifecycle = subscribeBackgroundLifecycle((snap) => {
    enqueueBackgroundCompletion(snap);
  });
}

function formatOne(snap: BackgroundProcSnapshot): string {
  const ageSec = Math.round(((snap.endedAt ?? Date.now()) - snap.startedAt) / 1000);
  const tag = snap.label ? ` (${snap.label})` : '';
  const exit =
    snap.status === 'error'
      ? `error: ${snap.errorMessage ?? 'unknown'}`
      : `exit ${snap.exitCode ?? '?'}${snap.signal ? ` signal ${snap.signal}` : ''}`;
  const lines = [`• ${snap.id}${tag} [${snap.status}] ${exit} · ${ageSec}s · ${snap.command}`];
  let tail = '';
  try {
    tail = getBackgroundProcessOutputTail(snap.id, MAX_TAIL_LINES);
  } catch {
    tail = '';
  }
  if (!tail) {
    const live = getBackgroundProcessSnapshot(snap.id);
    if (live?.errorMessage) tail = live.errorMessage;
  }
  if (tail) {
    let body = tail;
    if (body.length > MAX_REMINDER_CHARS) {
      body =
        body.slice(0, Math.floor(MAX_REMINDER_CHARS * 0.7)) +
        `\n... [${body.length - MAX_REMINDER_CHARS} chars omitted] ...\n` +
        body.slice(-Math.floor(MAX_REMINDER_CHARS * 0.25));
    }
    lines.push(`  --- last output ---`);
    for (const line of body.split('\n')) {
      lines.push(`  ${line}`);
    }
    lines.push(`  (full log: exec_logs("${snap.id}"))`);
  }
  return lines.join('\n');
}

/**
 * Drain unreported terminal background processes into human/model-readable
 * reminder strings. Each id is reported at most once.
 */
export function drainBackgroundCompletionReminders(): string[] {
  ensureBackgroundCompletionTracker();
  if (backgroundCompletionPending.length === 0) return [];
  const batch = backgroundCompletionPending.splice(0, backgroundCompletionPending.length);
  const out: string[] = [];
  for (const snap of batch) {
    if (backgroundCompletionReportedIds.has(snap.id)) continue;
    backgroundCompletionReportedIds.add(snap.id);
    out.push(formatOne(snap));
  }
  return out;
}

/** True when at least one unreported completion is queued. */
export function hasPendingBackgroundCompletions(): boolean {
  ensureBackgroundCompletionTracker();
  return backgroundCompletionPending.some((p) => !backgroundCompletionReportedIds.has(p.id));
}

/**
 * Build a single system message body for injection into the agent loop.
 * Returns null when there is nothing new to report.
 */
export function buildBackgroundCompletionSystemText(): string | null {
  const parts = drainBackgroundCompletionReminders();
  if (parts.length === 0) return null;
  return (
    '[System] Background command(s) finished while you were working:\n' +
    parts.join('\n\n') +
    '\n\nUse this evidence to continue (or call exec_logs for full output). ' +
    'Do not re-start the same command unless it failed and a retry is warranted.'
  );
}
