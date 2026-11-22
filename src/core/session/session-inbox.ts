import type { TaskIntentEntryState } from '../../contracts/task-intent.js';

export type SessionInboxDelivery = 'steer' | 'queue';

export interface SessionInboxEntry {
  readonly id: string;

  readonly prompt: string;

  readonly delivery: SessionInboxDelivery;

  readonly admittedSeq: number;

  promotedSeq?: number;

  /** User-intent receipt and recoverable projection, sharing inbox durability. */
  intent?: TaskIntentEntryState;

  /** The target run ended before canonical adoption. Still pending until ack. */
  deferred?: boolean;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionInboxAdmitInput {
  readonly id?: string;
  readonly prompt: string;

  readonly delivery?: SessionInboxDelivery;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class SessionInboxConflictError extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`Session inbox already contains an entry with id "${entryId}"`);
    this.name = 'SessionInboxConflictError';
    this.entryId = entryId;
  }
}

export class SessionInbox {
  private readonly entries: SessionInboxEntry[] = [];
  private admittedCounter = 0;
  private promotedCounter = 0;

  static readonly MAX_ENTRIES = 500;

  admit(input: SessionInboxAdmitInput): SessionInboxEntry {
    const id = input.id ?? `inbox_${randomUUID()}`;
    if (this.entries.some((e) => e.id === id)) throw new SessionInboxConflictError(id);
    const entry: SessionInboxEntry = {
      id,
      prompt: input.prompt,
      delivery: input.delivery ?? 'steer',
      admittedSeq: ++this.admittedCounter,
      metadata: input.metadata,
    };
    this.entries.push(entry);
    this.pruneIfNeeded();
    return entry;
  }

  pending(): readonly SessionInboxEntry[] {
    return this.entries.filter((e) => e.promotedSeq === undefined);
  }

  promotableSteers(): readonly SessionInboxEntry[] {
    return this.pending().filter((e) => e.delivery === 'steer');
  }

  nextQueued(): SessionInboxEntry | undefined {
    return this.pending().find((e) => e.delivery === 'queue' && !e.metadata?.intentOnly);
  }

  promote(id: string): SessionInboxEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Session inbox has no entry "${id}"`);
    if (entry.promotedSeq === undefined) entry.promotedSeq = ++this.promotedCounter;
    return entry;
  }

  setIntent(id: string, intent: TaskIntentEntryState): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`Session inbox has no entry "${id}"`);
    entry.intent = intent;
  }

  hasPendingWork(): boolean {
    return this.entries.some((e) => e.promotedSeq === undefined);
  }

  defer(id: string): SessionInboxEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Session inbox has no entry "${id}"`);
    if (entry.promotedSeq === undefined) entry.deferred = true;
    return entry;
  }

  private pruneIfNeeded(): void {
    const latestIntent = this.entries.filter((entry) => entry.intent?.snapshot).at(-1)?.id;
    while (
      this.entries.filter((entry) => !entry.metadata?.intentTombstone).length >
      SessionInbox.MAX_ENTRIES
    ) {
      const idx = this.entries.findIndex(
        (e) =>
          e.promotedSeq !== undefined &&
          e.id !== latestIntent &&
          !e.metadata?.intentTombstone &&
          (!e.intent || ['committed', 'needs_clarification'].includes(e.intent.status))
      );
      if (idx === -1) break;
      const entry = this.entries[idx]!;
      if (entry.intent) {
        this.entries[idx] = {
          ...entry,
          prompt: '',
          metadata: { intentTombstone: true },
          intent: {
            status: entry.intent.status,
            revision: entry.intent.revision ?? entry.intent.snapshot?.revision,
            digest: createHash('sha256').update(entry.prompt).digest('hex'),
            ...(entry.intent.taskId ? { taskId: entry.intent.taskId } : {}),
          },
        };
      } else this.entries.splice(idx, 1);
    }
  }

  toEntries(): SessionInboxEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Refresh persisted state without invalidating an active drain's inbox view. */
  refreshFrom(inbox: SessionInbox): void {
    this.entries.splice(0, this.entries.length, ...inbox.toEntries());
    this.admittedCounter = inbox.admittedCounter;
    this.promotedCounter = inbox.promotedCounter;
  }

  static fromEntries(entries: readonly SessionInboxEntry[]): SessionInbox {
    const inbox = new SessionInbox();
    for (const e of entries) inbox.entries.push({ ...e });
    inbox.admittedCounter = entries.reduce((m, e) => Math.max(m, e.admittedSeq), 0);
    inbox.promotedCounter = entries.reduce((m, e) => Math.max(m, e.promotedSeq ?? 0), 0);
    return inbox;
  }
}
import { createHash, randomUUID } from 'node:crypto';
