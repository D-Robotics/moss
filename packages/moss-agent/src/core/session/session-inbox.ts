/**
 * Session inbox — durable prompt admission, separated from execution.
 *
 * This is the foundation of the "admission vs execution" split: a prompt is first
 * *admitted* into a durable inbox (recording it without making it model-visible),
 * and only later *promoted* into the conversation by the runner at a safe boundary.
 * It lets the runtime support steering (insert a prompt into a running turn),
 * queueing (hold a prompt until the session is otherwise idle), durable replay of
 * pending input, and recovery — none of which a fire-and-forget `chat(prompt)` can.
 *
 * Delivery semantics (mirrors the opencode V2 session contract):
 *   - `steer` — promotes at the next safe provider-turn boundary while the current
 *     run still needs to continue. Multiple admitted steers promote together, in
 *     admission order.
 *   - `queue` — held in FIFO order while the run needs to continue; when the session
 *     would otherwise become idle, exactly one queued entry is promoted, then
 *     continuation is reevaluated before promoting another.
 *
 * The inbox is in-memory but fully serializable (`toEntries`/`fromEntries`) so a
 * host can persist pending input (e.g. alongside the JSONL session) and replay it
 * after a restart. Sequence counters resume from the restored entries.
 */

export type SessionInboxDelivery = 'steer' | 'queue';

export interface SessionInboxEntry {
  /** Stable id for this admission (caller-supplied or generated). */
  readonly id: string;
  /** The admitted user prompt text. */
  readonly prompt: string;
  /** How this prompt should be promoted into the conversation. */
  readonly delivery: SessionInboxDelivery;
  /** Monotonic admission sequence (durable order of acceptance). */
  readonly admittedSeq: number;
  /** Set once the prompt has been promoted into visible history. */
  promotedSeq?: number;
  /** Optional caller metadata (attachments, run options, …). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionInboxAdmitInput {
  readonly id?: string;
  readonly prompt: string;
  /** Defaults to `steer`. */
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

  /** Admit a prompt durably without making it model-visible yet. */
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
    return entry;
  }

  /** All admitted-but-not-yet-promoted entries, in admission order. */
  pending(): readonly SessionInboxEntry[] {
    return this.entries.filter((e) => e.promotedSeq === undefined);
  }

  /** Steers eligible to promote at a safe boundary (all pending steers, admission order). */
  promotableSteers(): readonly SessionInboxEntry[] {
    return this.pending().filter((e) => e.delivery === 'steer');
  }

  /** The next queued entry to promote when the session would otherwise idle. */
  nextQueued(): SessionInboxEntry | undefined {
    return this.pending().find((e) => e.delivery === 'queue');
  }

  /** Mark an entry promoted, assigning the next monotonic promotion sequence. */
  promote(id: string): SessionInboxEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Session inbox has no entry "${id}"`);
    if (entry.promotedSeq === undefined) entry.promotedSeq = ++this.promotedCounter;
    return entry;
  }

  /** True while any admitted prompt is still pending promotion. */
  hasPendingWork(): boolean {
    return this.entries.some((e) => e.promotedSeq === undefined);
  }

  /** Serializable snapshot of every entry (durable persistence / replay). */
  toEntries(): SessionInboxEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Rebuild an inbox from persisted entries; sequence counters resume from them. */
  static fromEntries(entries: readonly SessionInboxEntry[]): SessionInbox {
    const inbox = new SessionInbox();
    for (const e of entries) inbox.entries.push({ ...e });
    inbox.admittedCounter = entries.reduce((m, e) => Math.max(m, e.admittedSeq), 0);
    inbox.promotedCounter = entries.reduce((m, e) => Math.max(m, e.promotedSeq ?? 0), 0);
    return inbox;
  }
}
