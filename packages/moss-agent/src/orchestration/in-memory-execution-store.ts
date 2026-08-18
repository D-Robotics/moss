import { randomUUID } from 'node:crypto';

import { ErrorCode, MossError } from '../errors.js';
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

/** Options for the instance-owned in-memory execution store. @beta */
export interface InMemoryExecutionStoreOptions {
  readonly now?: () => number;
}

/** Deterministic in-memory adapter implementing the complete execution-store contract. @beta */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly graphs = new Map<string, ExecutionEvent[]>();
  private readonly eventGraphIds = new Map<string, string>();
  private readonly leases = new Map<string, ExecutionOwnerLease>();
  private readonly completionAuthorities = new WeakSet<object>();
  private readonly now: () => number;

  constructor(options: InMemoryExecutionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  create(input: CreateExecutionGraphInput): ExecutionGraphSnapshot {
    const existing = this.load(input.id);
    if (existing) return existing;
    const event = createGraphCreatedEvent(input, `exe_${randomUUID()}`);
    const graph = projectExecutionGraph([event]);
    this.graphs.set(input.id, [event]);
    this.eventGraphIds.set(event.id, input.id);
    return graph;
  }

  load(graphId: string): ExecutionGraphSnapshot | undefined {
    const events = this.graphs.get(graphId);
    return events ? projectExecutionGraph(events) : undefined;
  }

  list(): readonly ExecutionGraphSnapshot[] {
    return [...this.graphs.values()]
      .map(projectExecutionGraph)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  events(graphId: string, after = 0): readonly ExecutionEvent[] {
    return (this.graphs.get(graphId) ?? [])
      .filter((event) => event.seq > after)
      .map((event) => ({ ...event, data: { ...event.data } }));
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
    const events = this.graphs.get(graphId);
    if (!events) throw this.invalid(`unknown execution graph "${graphId}"`);
    this.assertAppendLease(graphId, input);
    const id = input.id ?? `exe_${randomUUID()}`;
    const existingGraphId = this.eventGraphIds.get(id);
    if (existingGraphId === graphId) return projectExecutionGraph(events);
    if (existingGraphId) throw this.invalid(`execution event "${id}" belongs to another graph`);
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
    const projected = projectExecutionGraph([...events, event]);
    events.push(event);
    this.eventGraphIds.set(event.id, graphId);
    return projected;
  }

  acquireLease(graphId: string, input: AcquireExecutionLeaseInput): ExecutionOwnerLease {
    if (!this.graphs.has(graphId)) throw this.invalid(`unknown execution graph "${graphId}"`);
    const now = this.now();
    const current = this.leases.get(graphId);
    if (current && current.expiresAt > now) {
      if (current.ownerId !== input.ownerId) throw this.leaseHeld(graphId, current.ownerId);
      const renewed = { ...current, expiresAt: now + (input.ttlMs ?? 30_000) };
      this.leases.set(graphId, renewed);
      return renewed;
    }
    const lease: ExecutionOwnerLease = {
      graphId,
      ownerId: input.ownerId,
      token: randomUUID(),
      acquiredAt: now,
      expiresAt: now + (input.ttlMs ?? 30_000),
    };
    this.leases.set(graphId, lease);
    return lease;
  }

  renewLease(lease: ExecutionOwnerLease, ttlMs = 30_000): ExecutionOwnerLease {
    const current = this.leases.get(lease.graphId);
    if (!current || current.token !== lease.token || current.expiresAt <= this.now())
      throw this.invalid('execution lease token is stale');
    const renewed = { ...current, expiresAt: this.now() + ttlMs };
    this.leases.set(lease.graphId, renewed);
    return renewed;
  }

  releaseLease(graphId: string, lease: ExecutionOwnerLease): void {
    const current = this.leases.get(graphId);
    if (!current || current.token !== lease.token)
      throw this.invalid('execution lease token is stale');
    this.leases.delete(graphId);
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
    const current = this.leases.get(graphId);
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
}
