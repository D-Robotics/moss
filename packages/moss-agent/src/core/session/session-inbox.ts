






















export type SessionInboxDelivery = 'steer' | 'queue';

export interface SessionInboxEntry {
  
  readonly id: string;
  
  readonly prompt: string;
  
  readonly delivery: SessionInboxDelivery;
  
  readonly admittedSeq: number;
  
  promotedSeq?: number;
  
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

let autoId = 0;

export class SessionInbox {
  private readonly entries: SessionInboxEntry[] = [];
  private admittedCounter = 0;
  private promotedCounter = 0;

  

  static readonly MAX_ENTRIES = 500;

  
  admit(input: SessionInboxAdmitInput): SessionInboxEntry {
    const id = input.id ?? `inbox_${Date.now().toString(36)}_${(autoId++).toString(36)}`;
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
    return this.pending().find((e) => e.delivery === 'queue');
  }

  
  promote(id: string): SessionInboxEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Session inbox has no entry "${id}"`);
    if (entry.promotedSeq === undefined) entry.promotedSeq = ++this.promotedCounter;
    return entry;
  }

  
  hasPendingWork(): boolean {
    return this.entries.some((e) => e.promotedSeq === undefined);
  }

  




  private pruneIfNeeded(): void {
    while (this.entries.length > SessionInbox.MAX_ENTRIES) {
      const idx = this.entries.findIndex((e) => e.promotedSeq !== undefined);
      if (idx === -1) break; 
      this.entries.splice(idx, 1);
    }
  }

  
  toEntries(): SessionInboxEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  
  static fromEntries(entries: readonly SessionInboxEntry[]): SessionInbox {
    const inbox = new SessionInbox();
    for (const e of entries) inbox.entries.push({ ...e });
    inbox.admittedCounter = entries.reduce((m, e) => Math.max(m, e.admittedSeq), 0);
    inbox.promotedCounter = entries.reduce((m, e) => Math.max(m, e.promotedSeq ?? 0), 0);
    return inbox;
  }
}
