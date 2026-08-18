import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ErrorCode, MossError, errorMessage } from '../errors.js';
import type {
  ExecutionEvidence,
  ExecutionGraphSnapshot,
  ExecutionNode,
  ExecutionNodeExecutor,
  ExecutionOwnerLease,
  ExecutionScheduleResult,
  ExecutionStore,
} from './execution-types.js';

/** Local owner-lease timings and identity for one scheduler instance. @beta */
export interface ExecutionGraphSchedulerOptions {
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
  readonly leaseRenewIntervalMs?: number;
}

const DEPENDENCY_FAILURES = new Set([
  'failed',
  'blocked',
  'cancelled',
  'merge_conflict',
  'interrupted',
]);

/** Normalize one declared write path without resolving it outside the workspace. @beta */
export function normalizeWritePath(value: string): string {
  const portable = value.trim().replaceAll('\\', '/');
  if (!portable || portable.startsWith('/') || /^[a-zA-Z]:\//.test(portable)) {
    throw new MossError({
      code: ErrorCode.EXECUTION_STATE_INVALID,
      message: `write path "${value}" must be workspace-relative`,
    });
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '').replace(/\/$/, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new MossError({
      code: ErrorCode.EXECUTION_STATE_INVALID,
      message: `write path "${value}" must be workspace-relative`,
    });
  }
  return normalized || '.';
}

/** Return whether two declared write-path sets overlap by exact or ancestor ownership. @beta */
export function writePathsOverlap(
  leftPaths: readonly string[],
  rightPaths: readonly string[]
): boolean {
  const left = leftPaths.map(normalizeWritePath);
  const right = rightPaths.map(normalizeWritePath);
  return left.some((a) =>
    right.some(
      (b) => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
    )
  );
}

function budgetReason(graph: ExecutionGraphSnapshot): string | undefined {
  const budget = graph.budget;
  if (budget.maxTokens !== undefined && (budget.usedTokens ?? 0) >= budget.maxTokens) {
    return 'token budget exhausted';
  }
  if (budget.maxCostUsd !== undefined && (budget.usedCostUsd ?? 0) >= budget.maxCostUsd) {
    return 'cost budget exhausted';
  }
  if (budget.maxWallTimeMs !== undefined && (budget.usedWallTimeMs ?? 0) >= budget.maxWallTimeMs) {
    return 'wall-time budget exhausted';
  }
  return undefined;
}

/** Instance-owned dependency scheduler for one or more execution graphs. @beta */
export class ExecutionGraphScheduler {
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewIntervalMs: number;

  constructor(
    private readonly store: ExecutionStore,
    options: ExecutionGraphSchedulerOptions = {}
  ) {
    this.ownerId = options.ownerId ?? `scheduler:${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = Math.max(1, options.leaseTtlMs ?? 30_000);
    this.leaseRenewIntervalMs = Math.max(
      1,
      Math.min(options.leaseRenewIntervalMs ?? 10_000, this.leaseTtlMs - 1 || 1)
    );
  }

  reconcile(graphId: string): ExecutionGraphSnapshot {
    return this.withLease(graphId, (lease) => this.reconcileOwned(graphId, lease));
  }

  private reconcileOwned(graphId: string, lease: ExecutionOwnerLease): ExecutionGraphSnapshot {
    let graph = this.requiredGraph(graphId);
    if (graph.status !== 'running') return graph;
    const exhausted = budgetReason(graph);
    if (exhausted) {
      graph = this.append(graphId, lease, {
        expectedRevision: graph.revision,
        type: 'graph.paused',
        data: { reason: exhausted, budget: graph.budget },
      });
      return graph;
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const node of Object.values(graph.nodes)) {
        const dependencies = node.dependencies.map((id) => graph.nodes[id]);
        const failedDependencies = dependencies
          .filter((dependency) => DEPENDENCY_FAILURES.has(dependency.status))
          .map((dependency) => dependency.id);
        const allSatisfied = dependencies.every(
          (dependency) => dependency.status === 'succeeded' || dependency.status === 'skipped'
        );

        if (
          failedDependencies.length > 0 &&
          (node.status === 'pending' || node.status === 'ready')
        ) {
          graph = this.append(graphId, lease, {
            expectedRevision: graph.revision,
            type: 'node.blocked',
            nodeId: node.id,
            data: {
              error: `Blocked by dependencies: ${failedDependencies.join(', ')}`,
              blockedByDependencies: failedDependencies,
            },
          });
          changed = true;
          break;
        }
        if (
          allSatisfied &&
          (node.status === 'pending' ||
            (node.status === 'blocked' && (node.blockedByDependencies?.length ?? 0) > 0))
        ) {
          graph = this.append(graphId, lease, {
            expectedRevision: graph.revision,
            type: 'node.ready',
            nodeId: node.id,
          });
          changed = true;
          break;
        }
      }
    }
    return graph;
  }

  selectRunnable(graph: ExecutionGraphSnapshot): readonly ExecutionNode[] {
    if (budgetReason(graph)) return [];
    if (graph.status !== 'running') return [];
    const active = Object.values(graph.nodes).filter(
      (node) => node.status === 'leased' || node.status === 'running'
    );
    const selected: ExecutionNode[] = [];
    const available = Math.max(0, graph.policy.maxConcurrency - active.length);
    for (const node of Object.values(graph.nodes)) {
      if (node.status !== 'ready' || selected.length >= available) continue;
      const writePaths = node.writePaths ?? [];
      const conflicts = [...active, ...selected].some((other) => {
        const otherPaths = other.writePaths ?? [];
        return (
          writePaths.length > 0 &&
          otherPaths.length > 0 &&
          writePathsOverlap(writePaths, otherPaths)
        );
      });
      if (!conflicts) selected.push(node);
    }
    return selected;
  }

  startNode(graphId: string, nodeId: string): ExecutionGraphSnapshot {
    return this.withLease(graphId, (lease) => this.startNodeOwned(graphId, nodeId, lease));
  }

  private startNodeOwned(
    graphId: string,
    nodeId: string,
    lease: ExecutionOwnerLease
  ): ExecutionGraphSnapshot {
    let graph = this.reconcileOwned(graphId, lease);
    let node = this.requiredNode(graph, nodeId);
    if (node.status === 'failed' || node.status === 'interrupted') {
      graph = this.append(graphId, lease, {
        expectedRevision: graph.revision,
        type: 'node.retry_requested',
        nodeId,
      });
      node = this.requiredNode(graph, nodeId);
    }
    if (node.status !== 'ready' && node.status !== 'leased') {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `node "${nodeId}" is not runnable from ${node.status}`,
      });
    }
    if (graph.status !== 'running') {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `execution graph "${graphId}" is not running (${graph.status})`,
      });
    }
    return this.append(graphId, lease, {
      expectedRevision: graph.revision,
      type: 'node.started',
      nodeId,
    });
  }

  succeedNode(
    graphId: string,
    nodeId: string,
    evidence: readonly ExecutionEvidence[] = []
  ): ExecutionGraphSnapshot {
    return this.withLease(graphId, (lease) =>
      this.succeedNodeOwned(graphId, nodeId, evidence, lease)
    );
  }

  private succeedNodeOwned(
    graphId: string,
    nodeId: string,
    evidence: readonly ExecutionEvidence[],
    lease: ExecutionOwnerLease
  ): ExecutionGraphSnapshot {
    const graph = this.recordEvidenceOwned(graphId, nodeId, evidence, lease);
    return this.append(graphId, lease, {
      expectedRevision: graph.revision,
      type: 'node.succeeded',
      nodeId,
    });
  }

  failNode(
    graphId: string,
    nodeId: string,
    failure: { readonly error: string; readonly failureFingerprint?: string }
  ): ExecutionGraphSnapshot {
    return this.withLease(graphId, (lease) => this.failNodeOwned(graphId, nodeId, failure, lease));
  }

  private failNodeOwned(
    graphId: string,
    nodeId: string,
    failure: { readonly error: string; readonly failureFingerprint?: string },
    lease: ExecutionOwnerLease
  ): ExecutionGraphSnapshot {
    let graph = this.requiredGraph(graphId);
    graph = this.append(graphId, lease, {
      expectedRevision: graph.revision,
      type: 'node.failed',
      nodeId,
      data: {
        error: failure.error,
        ...(failure.failureFingerprint ? { failureFingerprint: failure.failureFingerprint } : {}),
      },
    });
    const node = this.requiredNode(graph, nodeId);
    if (node.attempts >= graph.policy.maxAttemptsPerNode || node.consecutiveSameFailures >= 3) {
      graph = this.append(graphId, lease, {
        expectedRevision: graph.revision,
        type: 'node.blocked',
        nodeId,
        data: { error: failure.error, reason: 'retry_limit_reached' },
      });
    }
    return graph;
  }

  async runAvailable(
    graphId: string,
    executor: ExecutionNodeExecutor
  ): Promise<ExecutionScheduleResult> {
    let lease = this.acquireLease(graphId);
    let renewalFailure: unknown;
    let operationFailure: unknown;
    const executionAbort = new AbortController();
    const renewal = setInterval(() => {
      if (renewalFailure) return;
      try {
        lease = this.store.renewLease(lease, this.leaseTtlMs);
        const current = this.requiredGraph(graphId);
        if (current.status !== 'running') executionAbort.abort(`graph is ${current.status}`);
      } catch (error) {
        renewalFailure = error;
        executionAbort.abort(error);
      }
    }, this.leaseRenewIntervalMs);
    renewal.unref();
    try {
      let graph = this.reconcileOwned(graphId, lease);
      const candidates = this.selectRunnable(graph);
      const started: ExecutionNode[] = [];
      for (const candidate of candidates) {
        graph = this.startNodeOwned(graphId, candidate.id, lease);
        started.push(this.requiredNode(graph, candidate.id));
      }
      const settled = await Promise.all(
        started.map(async (node) => {
          try {
            return { node, result: await executor(node, graph, { signal: executionAbort.signal }) };
          } catch (error) {
            return {
              node,
              result: {
                success: false,
                error: errorMessage(error),
                failureFingerprint: `executor:${error instanceof Error ? error.name : 'unknown'}`,
              },
            };
          }
        })
      );
      if (renewalFailure) throw renewalFailure;
      const current = this.requiredGraph(graphId);
      if (current.status !== 'running') {
        return { graph: current, startedNodeIds: started.map((node) => node.id) };
      }
      for (const item of settled) {
        if (item.result.success) {
          graph = this.succeedNodeOwned(graphId, item.node.id, item.result.evidence ?? [], lease);
        } else {
          graph = this.recordEvidenceOwned(
            graphId,
            item.node.id,
            item.result.evidence ?? [],
            lease
          );
          graph = this.failNodeOwned(
            graphId,
            item.node.id,
            {
              error: item.result.error ?? 'Node execution failed',
              ...(item.result.failureFingerprint
                ? { failureFingerprint: item.result.failureFingerprint }
                : {}),
            },
            lease
          );
        }
      }
      graph = this.reconcileOwned(graphId, lease);
      return { graph, startedNodeIds: started.map((node) => node.id) };
    } catch (error) {
      operationFailure = error;
      throw error;
    } finally {
      clearInterval(renewal);
      try {
        this.store.releaseLease(graphId, lease);
      } catch (error) {
        if (!operationFailure) throw error;
      }
    }
  }

  private append(
    graphId: string,
    lease: ExecutionOwnerLease,
    input: Omit<Parameters<ExecutionStore['append']>[1], 'ownerLease'>
  ): ExecutionGraphSnapshot {
    return this.store.append(graphId, { ...input, ownerLease: lease });
  }

  private recordEvidenceOwned(
    graphId: string,
    nodeId: string,
    evidence: readonly ExecutionEvidence[],
    lease: ExecutionOwnerLease
  ): ExecutionGraphSnapshot {
    let graph = this.requiredGraph(graphId);
    for (const item of evidence) {
      graph = this.append(graphId, lease, {
        expectedRevision: graph.revision,
        type: 'evidence.recorded',
        nodeId,
        data: { evidence: { ...item, nodeId: item.nodeId ?? nodeId } },
      });
    }
    return graph;
  }

  private acquireLease(graphId: string): ExecutionOwnerLease {
    return this.store.acquireLease(graphId, { ownerId: this.ownerId, ttlMs: this.leaseTtlMs });
  }

  private withLease<T>(graphId: string, operation: (lease: ExecutionOwnerLease) => T): T {
    const lease = this.acquireLease(graphId);
    let operationFailure: unknown;
    try {
      return operation(lease);
    } catch (error) {
      operationFailure = error;
      throw error;
    } finally {
      try {
        this.store.releaseLease(graphId, lease);
      } catch (error) {
        if (!operationFailure) throw error;
      }
    }
  }

  private requiredGraph(graphId: string): ExecutionGraphSnapshot {
    const graph = this.store.load(graphId);
    if (!graph) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `unknown execution graph "${graphId}"`,
      });
    }
    return graph;
  }

  private requiredNode(graph: ExecutionGraphSnapshot, nodeId: string): ExecutionNode {
    const node = graph.nodes[nodeId];
    if (!node) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `unknown execution node "${nodeId}"`,
      });
    }
    return node;
  }
}
