/**
 * User-facing task chrome. Internal ids, raw metric tokens, and phase
 * markers stay in the runtime; this module is what the transcript shows.
 * Strings go through `tui()` so zh follows the existing locale flag.
 */
import { tui } from './tui/copy.js';

const METRIC_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const TASK_ID = /\btask_[A-Za-z0-9_]*\d[A-Za-z0-9_]*\b/g;
const EVIDENCE_ID = /\bev_[A-Za-z0-9_]+\b/g;

/** Drop ledger ids and snake_case metric names from a card label. */
export function hideTaskLabel(label: string): string {
  return label
    .replace(TASK_ID, '')
    .replace(EVIDENCE_ID, '')
    .replace(METRIC_TOKEN, '')
    .replace(/任务契约/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([=→])/g, ' $1')
    .trim();
}

export function formatTaskProgressLine(phase: string): string {
  switch (phase) {
    case 'planning':
      return tui('◇ Working out the steps');
    case 'executing':
      return tui('◇ Doing the work');
    case 'verifying':
      return tui('◇ Checking the result');
    case 'diagnosing':
      return tui('◇ Looking at what failed');
    case 'repairing':
      return tui('◇ Fixing it');
    case 'accepted':
      return tui('◇ Checks passed');
    case 'failed':
      return tui('◇ Checks did not pass');
    case 'blocked':
      return tui('◇ Waiting on you');
    default:
      return tui('◇ Working');
  }
}

export function formatTaskVerdictLine(result: 'PASS' | 'FAIL', met: number, total: number): string {
  return result === 'PASS'
    ? tui('◇ Checks passed ({met}/{total})', { met, total })
    : tui('◇ Checks did not pass ({met}/{total}) · /task resume', { met, total });
}

export function formatBlockedTaskLine(reason: string): string {
  return tui('◇ Blocked — {reason} · /task resume', { reason });
}

export function formatEvidenceFoldLine(count: number): string | undefined {
  if (count <= 0) return undefined;
  return tui(
    count === 1
      ? '{count} measurement hidden — expand to see'
      : '{count} measurements hidden — expand to see',
    { count }
  );
}

export interface TaskSummaryCard {
  kind: string;
  result?: string;
  state: string;
  goal: string;
  criteriaMet: number;
  criteriaTotal: number;
  blockedReason?: string;
}

export function formatTaskSummaryLines(summary: TaskSummaryCard, evidenceCount: number): string[] {
  const head =
    `${summary.kind.toUpperCase().padEnd(8)} ${
      summary.result === 'ABORTED'
        ? 'ABORTED'
        : `${(summary.result ?? summary.state).padEnd(10)} ${summary.criteriaMet}/${summary.criteriaTotal} ${tui('met')}`
    }  ${summary.goal}` +
    (summary.blockedReason
      ? `\n         ${tui('blocked: {reason}', { reason: summary.blockedReason })}`
      : '');
  const fold = formatEvidenceFoldLine(evidenceCount);
  return fold ? [head, `         ${fold}`] : [head];
}

export function formatEvidenceLine(record: {
  result: string;
  observed?: unknown;
  expected?: string;
}): string {
  const result = record.result.toUpperCase().padEnd(5);
  if (record.expected) {
    return `${result} ${tui('observed {observed} (want {expected})', {
      observed: String(record.observed ?? '?'),
      expected: record.expected,
    })}`;
  }
  return `${result} ${tui('observed {observed}', { observed: String(record.observed ?? '?') })}`;
}

export function formatTaskHistoryLines(detail: {
  goal: string;
  history: Array<{ kind: string; label: string }>;
}): string[] {
  return [
    detail.goal,
    ...detail.history
      .slice(-6)
      .map((entry) => `  ${entry.kind.padEnd(11)} ${hideTaskLabel(entry.label)}`),
  ];
}

export function formatTaskFailureLines(detail: {
  goal: string;
  failure?: { headline: string; items: Array<{ label: string }> };
}): string[] {
  return [
    `${detail.goal}: ${hideTaskLabel(detail.failure?.headline ?? '')}`,
    ...(detail.failure?.items ?? []).map((item) => `  ${hideTaskLabel(item.label)}`),
  ];
}
