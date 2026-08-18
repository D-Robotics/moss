import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import lockfile from 'proper-lockfile';

import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import { executionCompletionAuthority } from './completion-authority-internal.js';
import { createGraphCreatedEvent, projectExecutionGraph } from './execution-projector.js';
import type {
  AcquireExecutionLeaseInput,
  AppendExecutionEventInput,
  CreateExecutionGraphInput,
  ExecutionEvent,
  ExecutionCompletionAppender,
  ExecutionGraphSnapshot,
  ExecutionOwnerLease,
  ExecutionStore,
} from './execution-types.js';

/** JSONL execution-store configuration. @beta */
export interface JsonlExecutionStoreOptions {
  readonly rootDir: string;
  readonly snapshotEvery?: number;
  readonly now?: () => number;
}

interface PersistedSnapshot {
  readonly revision: number;
  readonly graph: ExecutionGraphSnapshot;
}

/** Durable local JSONL adapter with cross-process CAS and renewable graph ownership. @beta */
export class JsonlExecutionStore implements ExecutionStore {
  private readonly rootDir: string;
  private readonly snapshotEvery: number;
  private readonly now: () => number;
  private readonly completionAuthorities = new WeakSet<object>();

  constructor(options: JsonlExecutionStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.snapshotEvery = Math.max(1, Math.floor(options.snapshotEvery ?? 100));
    this.now = options.now ?? Date.now;
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
  }

  create(input: CreateExecutionGraphInput): ExecutionGraphSnapshot {
    const graphDir = this.graphDir(input.id);
    fs.mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const eventsFile = this.ensureEventsFile(input.id);
    return this.withFileLock(eventsFile, () => {
      const events = this.readEvents(input.id, true);
      if (events.length > 0) return projectExecutionGraph(events);
      const event = createGraphCreatedEvent(input, `exe_${randomUUID()}`);
      const snapshot = projectExecutionGraph([event]);
      this.appendLine(eventsFile, event);
      this.maybeWriteSnapshot(input.id, snapshot);
      return snapshot;
    });
  }

  load(graphId: string): ExecutionGraphSnapshot | undefined {
    const eventsFile = this.eventsFile(graphId);
    if (!fs.existsSync(eventsFile)) return undefined;
    return this.withFileLock(eventsFile, () => {
      const events = this.readEvents(graphId, true);
      return events.length > 0 ? projectExecutionGraph(events) : undefined;
    });
  }

  list(): readonly ExecutionGraphSnapshot[] {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch (error) {
      throw this.storeFailure('Failed to list execution graphs', error);
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.load(entry.name))
      .filter((snapshot): snapshot is ExecutionGraphSnapshot => snapshot !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  events(graphId: string, after = 0): readonly ExecutionEvent[] {
    const eventsFile = this.eventsFile(graphId);
    if (!fs.existsSync(eventsFile)) return [];
    return this.withFileLock(eventsFile, () =>
      this.readEvents(graphId, true)
        .filter((event) => event.seq > after)
        .map((event) => ({ ...event, data: { ...event.data } }))
    );
  }

  append(graphId: string, input: AppendExecutionEventInput): ExecutionGraphSnapshot {
    this.assertPublicAppend(input);
    return this.appendEvent(graphId, input);
  }

  bindCompletionAuthority(authority: object, owner: object): ExecutionCompletionAppender {
    if (authority !== executionCompletionAuthority) {
      throw this.invalid('execution completion authority is invalid');
    }
    this.completionAuthorities.add(owner);
    return (graphId, input) => {
      if (!this.completionAuthorities.has(owner)) {
        throw this.invalid('completion authority is no longer bound to this store');
      }
      return this.appendEvent(graphId, input);
    };
  }

  private appendEvent(graphId: string, input: AppendExecutionEventInput): ExecutionGraphSnapshot {
    const eventsFile = this.eventsFile(graphId);
    if (!fs.existsSync(eventsFile)) throw this.invalid(`unknown execution graph "${graphId}"`);
    return this.withFileLock(eventsFile, () => {
      const events = this.readEvents(graphId, true);
      this.assertAppendLease(graphId, input);
      const id = input.id ?? `exe_${randomUUID()}`;
      const duplicate = events.find((event) => event.id === id);
      if (duplicate) return projectExecutionGraph(events);
      if (events.length !== input.expectedRevision) {
        throw new MossError({
          code: ErrorCode.EXECUTION_REVISION_CONFLICT,
          message: `execution graph "${graphId}" revision is ${events.length}, expected ${input.expectedRevision}`,
          recoverable: true,
        });
      }
      const event: ExecutionEvent = {
        id,
        graphId,
        seq: events.length + 1,
        type: input.type,
        time: input.time ?? this.now(),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        data: input.data ?? {},
      };
      const snapshot = projectExecutionGraph([...events, event]);
      this.appendLine(eventsFile, event);
      this.maybeWriteSnapshot(graphId, snapshot);
      return snapshot;
    });
  }

  acquireLease(graphId: string, input: AcquireExecutionLeaseInput): ExecutionOwnerLease {
    const eventsFile = this.eventsFile(graphId);
    if (!fs.existsSync(eventsFile)) throw this.invalid(`unknown execution graph "${graphId}"`);
    return this.withFileLock(eventsFile, () => {
      const now = this.now();
      const current = this.readLease(graphId);
      if (current && current.expiresAt > now) {
        if (current.ownerId !== input.ownerId) throw this.leaseHeld(graphId, current.ownerId);
        const renewed = { ...current, expiresAt: now + (input.ttlMs ?? 30_000) };
        this.writeJsonAtomic(this.leaseFile(graphId), renewed);
        return renewed;
      }
      const lease: ExecutionOwnerLease = {
        graphId,
        ownerId: input.ownerId,
        token: randomUUID(),
        acquiredAt: now,
        expiresAt: now + (input.ttlMs ?? 30_000),
      };
      this.writeJsonAtomic(this.leaseFile(graphId), lease);
      return lease;
    });
  }

  renewLease(lease: ExecutionOwnerLease, ttlMs = 30_000): ExecutionOwnerLease {
    const eventsFile = this.eventsFile(lease.graphId);
    return this.withFileLock(eventsFile, () => {
      const current = this.readLease(lease.graphId);
      if (!current || current.token !== lease.token || current.expiresAt <= this.now())
        throw this.invalid('execution lease token is stale');
      const renewed = { ...current, expiresAt: this.now() + ttlMs };
      this.writeJsonAtomic(this.leaseFile(lease.graphId), renewed);
      return renewed;
    });
  }

  releaseLease(graphId: string, lease: ExecutionOwnerLease): void {
    const eventsFile = this.eventsFile(graphId);
    this.withFileLock(eventsFile, () => {
      const current = this.readLease(graphId);
      if (!current || current.token !== lease.token)
        throw this.invalid('execution lease token is stale');
      fs.unlinkSync(this.leaseFile(graphId));
    });
  }

  private graphDir(graphId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(graphId))
      throw this.invalid('graph id contains unsafe characters');
    return path.join(this.rootDir, graphId);
  }

  private eventsFile(graphId: string): string {
    return path.join(this.graphDir(graphId), 'events.jsonl');
  }

  private leaseFile(graphId: string): string {
    return path.join(this.graphDir(graphId), 'owner-lease.json');
  }

  private ensureEventsFile(graphId: string): string {
    const file = this.eventsFile(graphId);
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    return file;
  }

  private readEvents(graphId: string, repairTail: boolean): ExecutionEvent[] {
    const file = this.eventsFile(graphId);
    let body: string;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw this.storeFailure(`Failed to read execution graph "${graphId}"`, error);
    }
    const events: ExecutionEvent[] = [];
    let validBytes = 0;
    for (const segment of body.match(/.*(?:\n|$)/g) ?? []) {
      if (!segment) continue;
      const line = segment.endsWith('\n') ? segment.slice(0, -1) : segment;
      if (!line.trim()) {
        validBytes += Buffer.byteLength(segment);
        continue;
      }
      try {
        const event = JSON.parse(line) as ExecutionEvent;
        if (
          typeof event.id !== 'string' ||
          event.graphId !== graphId ||
          event.seq !== events.length + 1 ||
          typeof event.type !== 'string' ||
          typeof event.time !== 'number'
        ) {
          break;
        }
        events.push(event);
        validBytes += Buffer.byteLength(segment);
      } catch {
        break;
      }
    }
    if (repairTail && validBytes < Buffer.byteLength(body)) {
      const corrupt = Buffer.from(body).subarray(validBytes);
      const quarantine = path.join(
        this.graphDir(graphId),
        `events.corrupt.${this.now()}.${randomUUID().slice(0, 8)}.jsonl`
      );
      fs.writeFileSync(quarantine, corrupt, { mode: 0o600 });
      const descriptor = fs.openSync(file, 'r+');
      try {
        fs.ftruncateSync(descriptor, validBytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    return events;
  }

  private appendLine(file: string, event: ExecutionEvent): void {
    const descriptor = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(descriptor);
    } catch (error) {
      throw this.storeFailure('Failed to append execution event', error);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private maybeWriteSnapshot(graphId: string, graph: ExecutionGraphSnapshot): void {
    if (graph.revision % this.snapshotEvery !== 0) return;
    const snapshot: PersistedSnapshot = { revision: graph.revision, graph };
    this.writeJsonAtomic(path.join(this.graphDir(graphId), 'snapshot.json'), snapshot);
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }

  private readLease(graphId: string): ExecutionOwnerLease | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.leaseFile(graphId), 'utf8')) as ExecutionOwnerLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw this.storeFailure('Failed to read execution owner lease', error);
    }
  }

  private withFileLock<T>(file: string, operation: () => T): T {
    let release: (() => void) | undefined;
    try {
      release = lockfile.lockSync(file, { stale: 30_000, realpath: false });
      return operation();
    } catch (error) {
      if (error instanceof MossError) throw error;
      throw this.storeFailure('Failed to lock execution graph', error);
    } finally {
      release?.();
    }
  }

  private invalid(message: string): MossError {
    return new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }

  private assertPublicAppend(input: AppendExecutionEventInput): void {
    if (input.type === 'verification.recorded' || input.type === 'graph.completed') {
      throw this.invalid(`${input.type} may only be appended by CompletionArbiter`);
    }
  }

  private assertAppendLease(graphId: string, input: AppendExecutionEventInput): void {
    const current = this.readLease(graphId);
    const active = current && current.expiresAt > this.now() ? current : undefined;
    if (
      active &&
      !input.ownerLease &&
      ['graph.cancelled', 'graph.paused', 'steering.recorded'].includes(input.type)
    ) {
      return;
    }
    if (active && input.ownerLease?.token !== active.token) {
      throw this.leaseHeld(graphId, active.ownerId);
    }
    if (input.ownerLease && (!active || input.ownerLease.token !== active.token)) {
      throw this.leaseHeld(graphId, active?.ownerId ?? 'another owner');
    }
  }

  private leaseHeld(graphId: string, ownerId: string): MossError {
    return new MossError({
      code: ErrorCode.EXECUTION_LEASE_HELD,
      message: `execution graph "${graphId}" is leased by "${ownerId}"`,
      recoverable: true,
    });
  }

  private storeFailure(message: string, cause: unknown): MossError {
    return wrapAsMoss(cause, ErrorCode.EXECUTION_STORE_FAILED, { message, recoverable: true });
  }
}
