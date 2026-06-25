/**
 * Durable persistence for {@link SessionEventLog} — append-only JSONL.
 *
 * Events are the source of truth, so they are written append-only (one JSON object
 * per line) and never rewritten: a crash can only ever lose the last partial line,
 * which is skipped on load. Replaying the file rebuilds the in-memory log and
 * validates gap-free sequencing. This is the durable backbone the projector reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type SessionEvent, SessionEventLog } from './session-event.js';

/** Append one durable event as a JSONL line, creating parent dirs as needed. */
export function appendSessionEvent(filePath: string, event: SessionEvent): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

/** Persist an entire log (overwrites). Useful for compaction/rewrite; prefer append in steady state. */
export function writeSessionEventLog(filePath: string, log: SessionEventLog): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = log.toEvents().map((e) => JSON.stringify(e)).join('\n');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body.length ? `${body}\n` : '');
  fs.renameSync(tmp, filePath);
}

/** Load a durable event log from a JSONL file; a missing file yields an empty log. */
export function loadSessionEventLog(aggregateId: string, filePath: string): SessionEventLog {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return new SessionEventLog(aggregateId);
  }
  const events: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEvent);
    } catch {
      // Skip a corrupt/partial trailing line rather than failing the whole load.
    }
  }
  try {
    return SessionEventLog.fromEvents(aggregateId, events);
  } catch {
    // A duplicate/out-of-order/foreign-aggregate seq (e.g. two concurrent recorders interleaving
    // on the same session) is a fully-formed line the per-line guard above cannot skip, and
    // fromEvents throws on it — which would otherwise permanently brick every future history read.
    // Recover by keeping the longest valid gap-free 1-based prefix for this aggregate.
    const prefix: SessionEvent[] = [];
    let expected = 1;
    for (const event of events) {
      if (event.aggregateId !== aggregateId || event.seq !== expected) break;
      prefix.push(event);
      expected += 1;
    }
    return SessionEventLog.fromEvents(aggregateId, prefix);
  }
}
