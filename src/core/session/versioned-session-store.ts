import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type {
  CommittedContextCorrection,
  ContextCheckpoint,
  ContextClaim,
  ContextClaimDraft,
  ContextCorrection,
  ContextMessageOrigin,
  ContextSourceMessage,
  VersionedContextSnapshot,
} from '../../contracts/versioned-context.js';
import { ErrorCode, MossError } from '../../errors.js';
import type { LLMMessage } from '../llm/llm-provider.js';
import { redactJsonLine } from './redact-json-line.js';
import type { SessionMeta, SessionStore } from './session.js';
import { SessionInbox, type SessionInboxEntry } from './session-inbox.js';
import { loadSessionInbox } from './session-inbox-store.js';
import {
  emptyTaskIntent,
  readTaskIntent,
  validatePersistedTaskIntent,
} from './task-intent-state.js';

const loadBuiltin = createRequire(import.meta.url);

import { assertTaskExecutionCurrent } from '../task/task-execution-guard.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, imported INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS context_scopes (
    session TEXT PRIMARY KEY REFERENCES sessions(key) ON DELETE CASCADE,
    scope TEXT NOT NULL, first_ordinal INTEGER NOT NULL, first_revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL, body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, generation INTEGER,
    PRIMARY KEY (session, ordinal), UNIQUE (session, id)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    id TEXT NOT NULL, PRIMARY KEY (session, id)
  );
  CREATE TABLE IF NOT EXISTS corrections (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session, id)
  );
  CREATE TABLE IF NOT EXISTS checkpoints (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    revision INTEGER NOT NULL, covered INTEGER NOT NULL, policy TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (session, revision, covered, policy)
  );
  CREATE TABLE IF NOT EXISTS claims (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    id TEXT NOT NULL, ordinal INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    body TEXT NOT NULL, PRIMARY KEY (session, id)
  );
  CREATE TABLE IF NOT EXISTS inboxes (
    session TEXT PRIMARY KEY REFERENCES sessions(key) ON DELETE CASCADE, body TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS summary_usage (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    id TEXT NOT NULL, run TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(session, id)
  );
  CREATE TABLE IF NOT EXISTS summary_leases (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    source_key TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL,
    PRIMARY KEY(session, source_key)
  );
  CREATE TABLE IF NOT EXISTS requests (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(session, id)
  );
  CREATE TABLE IF NOT EXISTS execution_receipts (
    scope TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY(scope, id)
  );
  CREATE TABLE IF NOT EXISTS invocations (
    session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
    id TEXT NOT NULL, revision INTEGER NOT NULL, started INTEGER NOT NULL, settled INTEGER,
    tool TEXT NOT NULL, mutates INTEGER NOT NULL, resolution TEXT,
    PRIMARY KEY(session, id)
  );
  CREATE TABLE IF NOT EXISTS overlays (
    session TEXT PRIMARY KEY REFERENCES sessions(key) ON DELETE CASCADE,
    covered INTEGER NOT NULL, body TEXT NOT NULL
  );
`;

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function hashContextSources(messages: readonly ContextSourceMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

export class VersionedSessionStore implements SessionStore {
  private connection?: DatabaseSync;

  constructor(
    readonly databasePath: string,
    private readonly legacy?: SessionStore
  ) {}

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  private get db(): DatabaseSync {
    if (this.connection) return this.connection;
    const directory = dirname(this.databasePath);
    const mossDir = dirname(directory);
    if (basename(directory) === 'runtime' && basename(mossDir) === '.moss')
      ensureMossRuntimeGitignore(dirname(mossDir));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    closeSync(openSync(this.databasePath, 'a', 0o600));
    chmodSync(this.databasePath, 0o600);
    const { DatabaseSync: SQLite } = loadBuiltin('node:sqlite') as typeof import('node:sqlite');
    const db = new SQLite(this.databasePath);
    try {
      db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'
      );
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported context database version');
      db.exec(SCHEMA);
      if (version === 0) db.exec('PRAGMA user_version=1');
      this.connection = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction<T>(work: () => T, write = true): T {
    const db = this.db;
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private has(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE key=?').get(key));
  }

  private create(key: string): void {
    const now = Date.now();
    this.db
      .prepare('INSERT OR IGNORE INTO sessions(key,created,updated) VALUES(?,?,?)')
      .run(key, now, now);
  }

  private lastOrdinal(key: string): number {
    return Number(
      this.db
        .prepare('SELECT coalesce(max(ordinal),0) AS ordinal FROM messages WHERE session=?')
        .get(key)?.ordinal
    );
  }

  revision(key: string): number {
    return Number(
      this.db.prepare('SELECT revision FROM sessions WHERE key=?').get(key)?.revision ?? 0
    );
  }

  private append(
    key: string,
    message: LLMMessage,
    origin: ContextMessageOrigin,
    id: string = randomUUID(),
    generation?: number
  ): void {
    this.db
      .prepare(
        'INSERT INTO messages(session,ordinal,id,origin,body,generation) VALUES(?,?,?,?,?,?)'
      )
      .run(key, this.lastOrdinal(key) + 1, id, origin, redactJsonLine(message), generation ?? null);
    this.db.prepare('UPDATE sessions SET updated=? WHERE key=?').run(Date.now(), key);
  }

  private async adopt(key: string): Promise<void> {
    if (
      !this.legacy ||
      this.db.prepare('SELECT imported FROM sessions WHERE key=?').get(key)?.imported === 1
    )
      return;
    const snapshot = this.legacy.loadDeliverySnapshot
      ? await this.legacy.loadDeliverySnapshot(key)
      : { messages: await this.legacy.loadMessages(key), deliveryIds: [] };
    this.transaction(() => {
      if (this.db.prepare('SELECT imported FROM sessions WHERE key=?').get(key)?.imported === 1)
        return;
      this.create(key);
      this.db.prepare('UPDATE sessions SET imported=1 WHERE key=?').run(key);
      for (const message of snapshot.messages) this.append(key, message, 'legacy');
      for (const id of snapshot.deliveryIds)
        this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(key, id);
    });
  }

  private contextScope(
    key: string
  ): { scope: string; firstOrdinal: number; firstRevision: number } | undefined {
    const row = this.db
      .prepare('SELECT scope,first_ordinal,first_revision FROM context_scopes WHERE session=?')
      .get(key);
    return row
      ? {
          scope: String(row.scope),
          firstOrdinal: Number(row.first_ordinal),
          firstRevision: Number(row.first_revision),
        }
      : undefined;
  }

  activeContextScope(key: string): { id: string; revision: number } | undefined {
    const current = this.contextScope(key);
    return current ? { id: current.scope, revision: current.firstRevision } : undefined;
  }

  private sourceRows(key: string, includeInactive = false): ContextSourceMessage[] {
    const scope = includeInactive ? undefined : this.contextScope(key);
    return this.db
      .prepare(
        `SELECT id,ordinal,origin,body,generation FROM messages WHERE session=?
      ${includeInactive ? '' : 'AND active=1 AND ordinal>=? AND (generation IS NULL OR generation>=?)'}
      ORDER BY ordinal`
      )
      .all(
        ...(includeInactive ? [key] : [key, scope?.firstOrdinal ?? 0, scope?.firstRevision ?? 0])
      )
      .map((row) => ({
        id: String(row.id),
        ordinal: Number(row.ordinal),
        origin: String(row.origin) as ContextMessageOrigin,
        message: parse<LLMMessage>(row.body),
        ...(row.generation === null ? {} : { generatedRevision: Number(row.generation) }),
      }));
  }

  private activeCorrections(key: string): CommittedContextCorrection[] {
    const firstRevision = this.contextScope(key)?.firstRevision ?? 0;
    return this.db
      .prepare('SELECT body FROM corrections WHERE session=? AND revision>=? ORDER BY revision')
      .all(key, firstRevision)
      .map((row) => parse<CommittedContextCorrection>(row.body));
  }

  /** A trusted host can move the active context to a new scope without changing the source archive. */
  async enterContextScope(
    key: string,
    scope: string,
    options: { adoptCurrent?: boolean; boundaryMessage?: string; legacyInboxPath?: string } = {}
  ): Promise<boolean> {
    if (!scope.trim() || scope.length > 240)
      throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message: 'Invalid context scope' });
    await this.adopt(key);
    return this.transaction(() => {
      const previous = this.contextScope(key);
      if (previous?.scope === scope) return false;
      const lastOrdinal = this.lastOrdinal(key);
      const inbox = this.readInbox(key, () =>
        options.legacyInboxPath ? loadSessionInbox(options.legacyInboxPath) : new SessionInbox()
      );
      const startFresh =
        (lastOrdinal > 0 || Boolean(previous) || inbox.toEntries().length > 0) &&
        !(options.adoptCurrent && !previous);
      this.create(key);
      if (startFresh) this.retireContextIntent(inbox);
      this.saveInbox(key, inbox);
      const revision = this.revision(key) + 1;
      this.db
        .prepare('INSERT OR REPLACE INTO context_scopes VALUES(?,?,?,?)')
        .run(key, scope, startFresh ? lastOrdinal + 1 : 0, startFresh ? revision : 0);
      if (startFresh) {
        this.db.prepare('UPDATE claims SET active=0 WHERE session=?').run(key);
        this.db.prepare('DELETE FROM overlays WHERE session=?').run(key);
        this.db
          .prepare('UPDATE sessions SET revision=?,updated=? WHERE key=?')
          .run(revision, Date.now(), key);
        if (options.boundaryMessage?.trim()) {
          this.append(key, { role: 'user', content: options.boundaryMessage }, 'runtime');
        }
      }
      return true;
    });
  }

  private retireContextIntent(inbox: SessionInbox): void {
    const current = readTaskIntent(inbox.toEntries());
    if (current.pending || inbox.pending().length) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: 'Resolve pending input in the current context before switching scopes',
      });
    }
    if (!current.inputSeq) return;
    const entry = inbox.admit({
      id: `context-scope:${randomUUID()}`,
      prompt: '',
      metadata: { intentOnly: true },
    });
    inbox.promote(entry.id);
    inbox.setIntent(entry.id, {
      status: 'committed',
      snapshot: {
        ...emptyTaskIntent(),
        revision: current.revision + 1,
        inputSeq: entry.admittedSeq,
        processedSeq: entry.admittedSeq,
      },
    });
  }

  readInbox(key: string, legacy?: () => SessionInbox): SessionInbox {
    const row = this.db.prepare('SELECT body FROM inboxes WHERE session=?').get(key);
    if (!row) return legacy?.() ?? new SessionInbox();
    const entries = parse<SessionInboxEntry[]>(row.body);
    for (const entry of entries) {
      if (entry.intent) validatePersistedTaskIntent(entry.intent);
    }
    return SessionInbox.fromEntries(entries);
  }

  private saveInbox(key: string, inbox: SessionInbox): void {
    this.db
      .prepare('INSERT OR REPLACE INTO inboxes VALUES(?,?)')
      .run(key, JSON.stringify(inbox.toEntries()));
  }

  updateInbox<T>(
    key: string,
    update: (inbox: SessionInbox) => T,
    legacy?: () => SessionInbox
  ): { inbox: SessionInbox; result: T } {
    return this.transaction(() => {
      this.create(key);
      const inbox = this.readInbox(key, legacy);
      const result = update(inbox);
      this.saveInbox(key, inbox);
      return { inbox, result };
    });
  }

  async sourceMessages(key: string): Promise<ContextSourceMessage[]> {
    await this.adopt(key);
    return this.sourceRows(key, true);
  }

  snapshot(key: string): VersionedContextSnapshot {
    return this.transaction(
      () => ({
        revision: this.revision(key),
        messages: this.sourceRows(key),
        corrections: this.activeCorrections(key),
        claims: this.claimRows(key),
      }),
      false
    );
  }

  async loadMessages(key: string): Promise<LLMMessage[]> {
    return (await this.loadDeliverySnapshot(key)).messages;
  }

  async loadDeliverySnapshot(
    key: string
  ): Promise<{ messages: LLMMessage[]; deliveryIds: string[] }> {
    await this.adopt(key);
    return this.transaction(() => {
      const overlay = this.db.prepare('SELECT covered,body FROM overlays WHERE session=?').get(key);
      const source = this.sourceRows(key);
      const messages = overlay
        ? [
            ...parse<LLMMessage[]>(overlay.body),
            ...source
              .filter((row) => row.ordinal > Number(overlay.covered))
              .map((row) => row.message),
          ]
        : source.map((row) => row.message);
      const deliveryIds = this.db
        .prepare('SELECT id FROM receipts WHERE session=?')
        .all(key)
        .map((row) => String(row.id));
      return { messages, deliveryIds };
    }, false);
  }

  async appendMessage(
    key: string,
    message: LLMMessage,
    origin: ContextMessageOrigin = inferOrigin(message),
    generatedRevision?: number
  ): Promise<void> {
    await this.adopt(key);
    this.transaction(() => {
      this.create(key);
      this.append(key, message, origin, undefined, generatedRevision);
    });
  }

  async appendMessageOnce(key: string, id: string, message: LLMMessage): Promise<boolean> {
    if (!id) throw new Error('A non-empty deliveryId is required');
    await this.adopt(key);
    return this.transaction(() => {
      this.create(key);
      if (!this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(key, id).changes)
        return false;
      this.append(key, message, id.startsWith('tool-continuation:') ? 'tool' : 'user');
      return true;
    });
  }

  /** Import quoted historical context without admitting it as a new user input. */
  async appendContextHandoffOnce(input: {
    sourceKey: string;
    sourceRevision: number;
    targetKey: string;
    deliveryId: string;
    message: LLMMessage;
    scopeCheck?: {
      source?: ReturnType<VersionedSessionStore['activeContextScope']>;
      target?: ReturnType<VersionedSessionStore['activeContextScope']>;
    };
  }): Promise<'imported' | 'duplicate' | 'source-changed'> {
    const { sourceKey, sourceRevision, targetKey, deliveryId, message } = input;
    if (
      !sourceKey ||
      !targetKey ||
      sourceKey === targetKey ||
      !deliveryId ||
      message.role !== 'assistant'
    ) {
      throw new Error(
        'A context handoff requires distinct sessions, a delivery ID, and historical assistant text'
      );
    }
    await this.adopt(targetKey);
    return this.transaction(() => {
      if (
        this.db
          .prepare('SELECT 1 FROM receipts WHERE session=? AND id=?')
          .get(targetKey, deliveryId)
      )
        return 'duplicate';
      const scopeMatches = (
        key: string,
        expected: ReturnType<VersionedSessionStore['activeContextScope']>
      ) => {
        const current = this.activeContextScope(key);
        return current?.id === expected?.id && current?.revision === expected?.revision;
      };
      if (
        !this.has(sourceKey) ||
        this.revision(sourceKey) !== sourceRevision ||
        this.readInbox(sourceKey).pending().length ||
        (input.scopeCheck &&
          (!scopeMatches(sourceKey, input.scopeCheck.source) ||
            !scopeMatches(targetKey, input.scopeCheck.target)))
      )
        return 'source-changed';
      this.create(targetKey);
      this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(targetKey, deliveryId);
      this.append(targetKey, message, 'assistant', undefined, this.revision(targetKey));
      return 'imported';
    });
  }

  /** Claim a host-owned action before dispatch. A receipt makes no claim about its outcome. */
  claimExecutionReceipt(scope: string, id: string): boolean {
    if (!scope || !id) throw new Error('Execution receipt requires a host scope and identity');
    assertTaskExecutionCurrent();
    return this.transaction(() =>
      Boolean(
        this.db.prepare('INSERT OR IGNORE INTO execution_receipts VALUES(?,?)').run(scope, id)
          .changes
      )
    );
  }

  async seedIfEmpty(key: string, messages: LLMMessage[]): Promise<LLMMessage[]> {
    await this.adopt(key);
    return this.transaction(() => {
      this.create(key);
      if (!this.lastOrdinal(key)) {
        for (const message of messages) this.append(key, message, 'legacy');
      }
      return this.sourceRows(key).map((row) => row.message);
    });
  }

  async replaceMessages(
    key: string,
    messages: LLMMessage[],
    options?: { deliveryIds?: readonly string[] }
  ): Promise<void> {
    await this.adopt(key);
    this.transaction(() => {
      this.create(key);
      if (this.lastOrdinal(key) === 0) {
        for (const message of messages) this.append(key, message, 'legacy');
      }
      this.db
        .prepare('INSERT OR REPLACE INTO overlays VALUES(?,?,?)')
        .run(key, this.lastOrdinal(key), redactJsonLine(messages));
      for (const id of options?.deliveryIds ?? [])
        this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(key, id);
    });
  }

  async rewind(key: string, count: number): Promise<number> {
    await this.adopt(key);
    return this.transaction(() => {
      const source = this.sourceRows(key);
      const keep = Math.max(0, Math.floor(count));
      if (keep >= source.length) return 0;
      this.db
        .prepare('UPDATE messages SET active=0 WHERE session=? AND ordinal>?')
        .run(key, keep === 0 ? 0 : source[keep - 1]!.ordinal);
      this.db.prepare('DELETE FROM overlays WHERE session=?').run(key);
      const kept = new Set(this.sourceRows(key).map((row) => row.id));
      this.invalidateClaims(key, ({ sourceIds }) => sourceIds.some((id) => !kept.has(id)));
      this.db
        .prepare('UPDATE sessions SET revision=revision+1,updated=? WHERE key=?')
        .run(Date.now(), key);
      return source.length - keep;
    });
  }

  async correct(
    key: string,
    input: ContextCorrection,
    admission?: { apply(inbox: SessionInbox): void; legacy?: () => SessionInbox }
  ): Promise<CommittedContextCorrection> {
    await this.adopt(key);
    return this.transaction(() => {
      const result = this.correctInTransaction(key, input);
      if (admission) {
        const inbox = this.readInbox(key, admission.legacy);
        admission.apply(inbox);
        this.saveInbox(key, inbox);
      }
      return result;
    });
  }

  /** Called only by an intent commit already inside the session transaction. */
  correctInTransaction(key: string, input: ContextCorrection): CommittedContextCorrection {
    if (
      !input.id.trim() ||
      !input.targetId.trim() ||
      !input.text.trim() ||
      input.text.length > 8000
    ) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'A correction requires an ID, a target and bounded text',
      });
    }
    const clean = parse<ContextCorrection>(redactJsonLine(input));
    const previous = this.db
      .prepare('SELECT body FROM corrections WHERE session=? AND id=?')
      .get(key, input.id);
    if (previous) {
      const value = parse<CommittedContextCorrection>(previous.body);
      if (
        value.targetId !== clean.targetId ||
        value.text !== clean.text ||
        value.revision < (this.contextScope(key)?.firstRevision ?? 0)
      ) {
        throw new MossError({
          code: ErrorCode.EXECUTION_REVISION_CONFLICT,
          message: 'Correction ID was reused for different content',
        });
      }
      return value;
    }
    const target = this.db
      .prepare(
        'SELECT ordinal,body FROM messages WHERE session=? AND id=? AND active=1 AND ordinal>=?'
      )
      .get(key, clean.targetId, this.contextScope(key)?.firstOrdinal ?? 0);
    const claim = this.claimRows(key).find(
      (item) => item.id === clean.targetId && item.status === 'active'
    );
    if ((!target || parse<LLMMessage>(target.body).role !== 'assistant') && !claim) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'Target must be an active assistant message or claim in this session',
      });
    }
    const revision = this.revision(key) + 1;
    const row: CommittedContextCorrection = {
      ...clean,
      revision,
      fromOrdinal: target ? Number(target.ordinal) : claim!.ordinal,
      throughOrdinal: this.lastOrdinal(key),
    };
    this.invalidateClaims(
      key,
      (item) => item.id === clean.targetId || item.sourceIds.includes(clean.targetId)
    );
    this.db
      .prepare('INSERT INTO corrections VALUES(?,?,?,?)')
      .run(key, row.id, revision, redactJsonLine(row));
    this.db
      .prepare('UPDATE sessions SET revision=?,updated=? WHERE key=?')
      .run(revision, Date.now(), key);
    return row;
  }

  private claimRows(key: string): ContextClaim[] {
    return this.db
      .prepare('SELECT body,active FROM claims WHERE session=? ORDER BY ordinal,id')
      .all(key)
      .map((row) => ({
        ...parse<ContextClaim>(row.body),
        status: row.active ? 'active' : 'invalidated',
      }));
  }

  private invalidateClaims(key: string, matches: (claim: ContextClaim) => boolean): void {
    const claims = this.claimRows(key);
    const invalid = new Set(
      claims.filter((claim) => claim.status === 'invalidated' || matches(claim)).map(({ id }) => id)
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const claim of claims) {
        if (!invalid.has(claim.id) && claim.dependsOn.some((id) => invalid.has(id))) {
          invalid.add(claim.id);
          changed = true;
        }
      }
    }
    const update = this.db.prepare(
      'UPDATE claims SET active=0 WHERE session=? AND id=? AND active=1'
    );
    for (const id of invalid) update.run(key, id);
  }

  /** Joins the transaction that is recording the model's validated declaration. */
  registerClaimsInTransaction(key: string, drafts: ContextClaimDraft[]): ContextClaim[] {
    const sources = new Map(this.sourceRows(key).map((row) => [row.id, row]));
    const corrections = this.activeCorrections(key);
    const active = new Set(
      this.claimRows(key)
        .filter((claim) => claim.status === 'active')
        .map(({ id }) => id)
    );
    const insert = this.db.prepare('INSERT INTO claims(session,id,ordinal,body) VALUES(?,?,?,?)');
    return drafts.map((draft) => {
      if (
        draft.dependsOn.some((id) => !active.has(id)) ||
        draft.sourceIds.some((id) => {
          const source = sources.get(id);
          return (
            !source ||
            (source.origin !== 'user' &&
              source.origin !== 'tool' &&
              corrections.some(
                (correction) =>
                  source.ordinal >= correction.fromOrdinal &&
                  (source.ordinal <= correction.throughOrdinal ||
                    (source.generatedRevision !== undefined &&
                      source.generatedRevision < correction.revision))
              ))
          );
        })
      )
        throw new MossError({
          code: ErrorCode.EXECUTION_REVISION_CONFLICT,
          message: 'Claim refers to a missing or invalidated source',
        });
      const ordinal = this.lastOrdinal(key) + 1;
      const claim: ContextClaim = { ...draft, id: randomUUID(), ordinal, status: 'active' };
      insert.run(key, claim.id, ordinal, redactJsonLine(claim));
      return claim;
    });
  }

  assertClaimsActive(key: string, dependencies: string[]): boolean {
    const exists = this.db.prepare('SELECT active FROM claims WHERE session=? AND id=?');
    return dependencies.every((id) => exists.get(key, id)?.active === 1);
  }

  recordSummaryUsage(key: string, run: string, usage: unknown): void {
    this.connection
      ?.prepare('INSERT INTO summary_usage VALUES(?,?,?,?)')
      .run(key, randomUUID(), run, redactJsonLine(usage));
  }

  reserveSummary(
    key: string,
    revision: number,
    sourceKey: string,
    owner: string,
    ttlMs: number
  ): boolean {
    return this.transaction(() => {
      if (this.revision(key) !== revision || !this.has(key)) return false;
      this.db
        .prepare('DELETE FROM summary_leases WHERE session=? AND expires<=?')
        .run(key, Date.now());
      return Boolean(
        this.db
          .prepare('INSERT OR IGNORE INTO summary_leases VALUES(?,?,?,?)')
          .run(key, sourceKey, owner, Date.now() + ttlMs).changes
      );
    });
  }

  releaseSummary(key: string, sourceKey: string, owner: string): void {
    this.connection
      ?.prepare('DELETE FROM summary_leases WHERE session=? AND source_key=? AND owner=?')
      .run(key, sourceKey, owner);
  }

  recordRequest(key: string, revision: number, body: unknown): boolean {
    return this.transaction(() => {
      if (this.revision(key) !== revision) return false;
      this.create(key);
      this.db
        .prepare('INSERT INTO requests VALUES(?,?,?,?)')
        .run(key, randomUUID(), revision, redactJsonLine(body));
      return true;
    });
  }

  registerInvocation(
    key: string,
    id: string,
    revision: number,
    tool: string,
    mutates: boolean,
    assertIntent: () => void
  ): () => void {
    this.transaction(() => {
      assertIntent();
      if (this.revision(key) !== revision) {
        throw new MossError({
          code: ErrorCode.EXECUTION_REVISION_CONFLICT,
          message: 'Context changed before tool dispatch',
        });
      }
      if (mutates && this.unsettledInvocations(key).length > 0) {
        throw new MossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message:
            'A previously dispatched mutation has an unknown outcome. Check the target state and reconcile the invocation before another write.',
        });
      }
      this.db
        .prepare(
          'INSERT INTO invocations(session,id,revision,started,tool,mutates) VALUES(?,?,?,?,?,?)'
        )
        .run(key, id, revision, Date.now(), tool, mutates ? 1 : 0);
    });
    return () => {
      this.db
        .prepare('UPDATE invocations SET settled=? WHERE session=? AND id=?')
        .run(Date.now(), key, id);
    };
  }

  unsettledInvocations(key: string): Array<{ id: string; tool: string; startedAt: number }> {
    return this.db
      .prepare(
        'SELECT id,tool,started FROM invocations WHERE session=? AND mutates=1 AND settled IS NULL ORDER BY started'
      )
      .all(key)
      .map((row) => ({
        id: String(row.id),
        tool: String(row.tool),
        startedAt: Number(row.started),
      }));
  }

  reconcileInvocation(key: string, id: string, observation: string): boolean {
    const text = observation.trim();
    if (!text || text.length > 8000)
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'Provide a bounded observation of the tool outcome',
      });
    return this.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT tool FROM invocations WHERE session=? AND id=? AND settled IS NULL AND mutates=1'
        )
        .get(key, id);
      if (!row) return false;
      this.db
        .prepare('UPDATE invocations SET settled=?, resolution=? WHERE session=? AND id=?')
        .run(Date.now(), redactJsonLine(text), key, id);
      this.append(
        key,
        {
          role: 'user',
          content: `Observed outcome of ${String(row.tool)} (${id}): ${text}`,
        },
        'user'
      );
      this.db.prepare('UPDATE sessions SET revision=revision+1 WHERE key=?').run(key);
      return true;
    });
  }

  earlierCheckpointBoundary(key: string, revision: number, policyKey: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT covered FROM checkpoints WHERE session=? AND revision<? AND covered>=? AND substr(policy,instr(policy,':')+1)=? ORDER BY revision DESC, covered DESC LIMIT 1`
      )
      .get(key, revision, this.contextScope(key)?.firstOrdinal ?? 0, policyKey);
    return row ? Number(row.covered) : undefined;
  }

  hasRecordedCorrection(key: string, targetId: string, text: string): boolean {
    const clean = parse<Pick<ContextCorrection, 'targetId' | 'text'>>(
      redactJsonLine({ targetId, text })
    );
    return this.activeCorrections(key).some(
      (correction) => correction.targetId === clean.targetId && correction.text === clean.text
    );
  }

  checkpoint(key: string, revision: number, policy: string): ContextCheckpoint | undefined {
    const row = this.db
      .prepare(
        'SELECT body FROM checkpoints WHERE session=? AND revision=? AND policy=? ORDER BY covered DESC LIMIT 1'
      )
      .get(key, revision, policy);
    return row ? parse<ContextCheckpoint>(row.body) : undefined;
  }

  commitCheckpoint(key: string, checkpoint: ContextCheckpoint): boolean {
    return this.transaction(() => {
      if (this.revision(key) !== checkpoint.revision) return false;
      const covered = this.sourceRows(key).filter(
        (row) => row.ordinal <= checkpoint.throughOrdinal
      );
      if (!covered.length || hashContextSources(covered) !== checkpoint.sourceHash) return false;
      this.db
        .prepare('INSERT OR IGNORE INTO checkpoints VALUES(?,?,?,?,?)')
        .run(
          key,
          checkpoint.revision,
          checkpoint.throughOrdinal,
          checkpoint.policy,
          redactJsonLine(checkpoint)
        );
      return true;
    });
  }

  async listSessions(): Promise<SessionMeta[]> {
    const legacy = (await this.legacy?.listSessions()) ?? [];
    const rows = this.db
      .prepare(
        `SELECT key,created,updated,
      (SELECT count(*) FROM messages WHERE session=key AND active=1) AS count
      FROM sessions ORDER BY updated DESC`
      )
      .all()
      .map((row) => ({
        sessionKey: String(row.key),
        createdAt: Number(row.created),
        updatedAt: Number(row.updated),
        messageCount: Number(row.count),
      }));
    const keys = new Set(rows.map((row) => row.sessionKey));
    return [...rows, ...legacy.filter((row) => !keys.has(row.sessionKey))].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
  }

  async deleteSession(key: string): Promise<void> {
    if (this.legacy && (await this.legacy.exists(key))) await this.legacy.deleteSession(key);
    this.db.prepare('DELETE FROM sessions WHERE key=?').run(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.has(key) || (await this.legacy?.exists(key)) === true;
  }
}

function inferOrigin(message: LLMMessage): ContextMessageOrigin {
  if (message.role === 'assistant') return 'assistant';
  if (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_result')
  )
    return 'tool';
  return 'runtime';
}
