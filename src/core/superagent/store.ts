import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  Repositories,
  Trigger,
  TriggerDisposition,
  Thread,
  Ticket,
  Decision,
} from './upstream/index.js';

/** Domain rows and queued effects share the same synchronous SQLite transaction. */
export class SuperagentStore {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(kind,key));`);
    const schema = this.get<number>('meta', 'schema');
    if (schema !== undefined && schema !== 1) {
      this.db.close();
      throw new Error('Unsupported Super-agent store schema');
    }
    this.set('meta', 'schema', 1);
  }

  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND key=?').get(kind, key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  set(kind: string, key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO records(kind,key,value) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value'
      )
      .run(kind, key, JSON.stringify(value));
  }
  remove(kind: string, key: string): void {
    this.db.prepare('DELETE FROM records WHERE kind=? AND key=?').run(kind, key);
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare('SELECT value FROM records WHERE kind=? ORDER BY seq')
      .all(kind)
      .map((row) => JSON.parse(String(row.value)) as T);
  }
  atomic<T>(work: () => T): T {
    const level = this.depth;
    this.db.exec(level ? `SAVEPOINT nested_${level}` : 'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const value = work();
      this.db.exec(level ? `RELEASE nested_${level}` : 'COMMIT');
      return value;
    } catch (error) {
      this.db.exec(level ? `ROLLBACK TO nested_${level}; RELEASE nested_${level}` : 'ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }
  close(): void {
    this.db.close();
  }

  readonly repo: Repositories = {
    atomic: (work) => this.atomic(work),
    triggers: {
      get: (id) => this.get<Trigger>('trigger', id),
      save: (row) => this.set('trigger', row.id, row),
      disposition: (id) => this.get<TriggerDisposition>('disposition', id),
      saveDisposition: (id, row) => this.set('disposition', id, row),
    },
    threads: {
      get: (id) => this.get<Thread>('thread', id),
      save: (row) => this.set('thread', row.key, row),
      list: () => this.list<Thread>('thread'),
      active: () =>
        this.list<Thread>('thread').filter((row) => row.pending.length > 0 || !!row.evaluating),
    },
    tickets: {
      get: (id) => this.get<Ticket>('ticket', id),
      save: (row) => this.set('ticket', row.id, row),
      list: () => this.list<Ticket>('ticket').reverse(),
      open: () =>
        this.list<Ticket>('ticket')
          .filter((row) => !row.ended)
          .reverse(),
      active: () =>
        this.list<Ticket>('ticket')
          .filter(
            (row) =>
              row.undelivered.length > 0 ||
              ['pending', 'running'].includes(row.assignments.at(-1)?.state ?? '')
          )
          .reverse(),
    },
    decisions: {
      get: (id) => this.get<Decision>('decision', id),
      save: (row) => this.set('decision', row.id, row),
      byThread: (id) => this.list<Decision>('decision').filter((row) => row.threadKey === id),
    },
  };
}
