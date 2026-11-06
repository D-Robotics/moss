/**
 * `moss runs follow`: watch the unified ledger the way `loop follow` watches a
 * loop. Pure diff helpers live here so probes can exercise new/update detection
 * without spawning a second writer mid-run.
 */
import type { RunRecord } from '../core/run-ledger.js';

/** Parse a follow duration (`500ms`, `1s`, `5m`, `1h`, optional space). */
export function parseFollowDuration(raw: string): number | undefined {
  const match = /^(\d+)\s*(ms|s|m|h)$/i.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2]!.toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return value * factor;
}

export interface FollowEvent {
  type: 'new' | 'update';
  record: RunRecord;
}

export interface FollowDiff {
  events: FollowEvent[];
  next: Map<string, RunRecord>;
}

/**
 * Compare the previous snapshot with the current ledger read.
 * - a run id that was not seen before is `new`;
 * - a seen run whose status/endedAt changed is an `update` (e.g. running → pass).
 * Events are returned newest first for stable output.
 */
export function followDiff(
  previous: ReadonlyMap<string, RunRecord>,
  records: readonly RunRecord[]
): FollowDiff {
  const events: FollowEvent[] = [];
  const next = new Map<string, RunRecord>();
  for (const record of records) {
    next.set(record.runId, record);
    const seen = previous.get(record.runId);
    if (!seen) events.push({ type: 'new', record });
    else if (seen.status !== record.status || seen.endedAt !== record.endedAt) {
      events.push({ type: 'update', record });
    }
  }
  events.sort((left, right) => right.record.endedAt - left.record.endedAt);
  return { events, next };
}

export function formatFollowEvent(event: FollowEvent, zh = false): string {
  const prefix = event.type === 'new' ? '+' : '~';
  const time = new Date(event.record.endedAt).toLocaleTimeString(zh ? 'en-GB' : [], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const goal = event.record.goal.replace(/\s+/g, ' ').trim();
  const label = zh ? `(${event.type === 'new' ? '新' : '更新'})` : '';
  return `${prefix} ${time} ${event.record.status} ${event.record.kind} ${event.record.runId}${label ? ` ${label}` : ''}${goal ? ` — ${goal}` : ''}`;
}
