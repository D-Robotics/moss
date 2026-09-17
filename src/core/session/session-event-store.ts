import fs from 'node:fs';
import path from 'node:path';
import { type SessionEvent, SessionEventLog } from './session-event.js';

export function appendSessionEvent(filePath: string, event: SessionEvent): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function writeSessionEventLog(filePath: string, log: SessionEventLog): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = log
    .toEvents()
    .map((e) => JSON.stringify(e))
    .join('\n');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body.length ? `${body}\n` : '', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

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
    } catch {}
  }
  try {
    return SessionEventLog.fromEvents(aggregateId, events);
  } catch {
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
