import fs from 'node:fs';
import path from 'node:path';

import type { MossWebJournalEvent, MossWebStreamEvent } from './web-contracts.js';

type MossWebJournalRecord = MossWebJournalEvent;

type JournalListener = (record: MossWebJournalRecord) => void;

const WEB_EVENT_TYPES = new Set<MossWebStreamEvent['type']>([
  'run',
  'text',
  'thought',
  'tool',
  'done',
  'retry',
  'compaction',
  'usage',
  'context',
  'interrupted',
  'error',
]);

function isJournalRecord(value: unknown): value is MossWebJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<MossWebJournalRecord>;
  return (
    typeof record.runId === 'string' &&
    typeof record.sessionId === 'string' &&
    Number.isSafeInteger(record.seq) &&
    (record.seq ?? 0) > 0 &&
    typeof record.time === 'number' &&
    Boolean(record.event) &&
    typeof record.event === 'object' &&
    typeof (record.event as { type?: unknown }).type === 'string' &&
    WEB_EVENT_TYPES.has((record.event as MossWebStreamEvent).type)
  );
}

/** Instance-owned durable browser event stream used for cursor recovery. @internal */
export class MossWebEventJournal {
  private readonly records = new Map<string, MossWebJournalRecord[]>();

  private readonly listeners = new Map<string, Set<JournalListener>>();

  constructor(private readonly filePath?: string) {
    if (filePath) this.load(filePath);
  }

  append(runId: string, sessionId: string, event: MossWebStreamEvent): MossWebJournalRecord {
    const records = this.records.get(runId) ?? [];
    const record: MossWebJournalRecord = {
      runId,
      sessionId,
      seq: records.length + 1,
      time: Date.now(),
      event,
    };
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }
    records.push(record);
    this.records.set(runId, records);
    for (const listener of this.listeners.get(runId) ?? []) {
      try {
        listener({ ...record });
      } catch {
        // A disconnected browser must not fail the agent run that owns this journal.
      }
    }
    return { ...record };
  }

  events(runId: string, after = 0): readonly MossWebJournalRecord[] {
    return (this.records.get(runId) ?? [])
      .filter((record) => record.seq > after)
      .map((record) => ({ ...record }));
  }

  latestSequence(runId: string): number {
    return this.records.get(runId)?.at(-1)?.seq ?? 0;
  }

  subscribe(runId: string, listener: JournalListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<JournalListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  private load(filePath: string): void {
    let body: string;
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const validLines: string[] = [];
    let needsRepair = false;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        needsRepair = true;
        break;
      }
      if (!isJournalRecord(parsed)) {
        needsRepair = true;
        break;
      }
      const records = this.records.get(parsed.runId) ?? [];
      if (parsed.seq !== records.length + 1) {
        needsRepair = true;
        break;
      }
      records.push(parsed);
      this.records.set(parsed.runId, records);
      validLines.push(JSON.stringify(parsed));
    }
    if (needsRepair) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, validLines.length > 0 ? `${validLines.join('\n')}\n` : '', {
        mode: 0o600,
      });
    }
  }
}

/** Parse a numeric or run-scoped browser event cursor without accepting a foreign run. @internal */
export function parseMossWebEventCursor(runId: string, raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 0;
  const separator = value.lastIndexOf(':');
  const cursorRunId = separator >= 0 ? value.slice(0, separator) : runId;
  const sequenceText = separator >= 0 ? value.slice(separator + 1) : value;
  if (cursorRunId !== runId || !/^\d+$/.test(sequenceText)) return 0;
  const sequence = Number(sequenceText);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}
