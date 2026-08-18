import path from 'node:path';

import { ErrorCode, MossError, errorMessage } from '../errors.js';
import type {
  ExecutionEvidence,
  ExecutionGraphSnapshot,
  ExecutionNode,
  ExecutionNodeExecutor,
  ExecutionScheduleResult,
  ExecutionStore,
} from './execution-types.js';

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
  constructor(private readonly store: ExecutionStore) {}

  reconcile(graphId: string): ExecutionGraphSnapshot {
    let graph = this.requiredGraph(graphId);
    const exhausted = budgetReason(graph);
    if (exhausted) {
      if (graph.status !== 'paused') {
        graph = this.store.append(graphId, {
          expectedRevision: graph.revision,
          type: 'graph.paused',
          data: { reason: exhausted, budget: graph.budget },
        });
      } else {
        graph = this.store.append(graphId, {
          expectedRevision: graph.revision,
          type: 'graph.paused',
          data: { reason: exhausted, budget: graph.budget },
        });
      }
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
          graph = this.store.append(graphId, {
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
          graph = this.store.append(graphId, {
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
    if (graph.status === 'blocked' || graph.status === 'completed' || graph.status === 'failed') {
      return [];
    }
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
    let graph = this.reconcile(graphId);
    let node = this.requiredNode(graph, nodeId);
    if (node.status === 'failed' || node.status === 'interrupted') {
      graph = this.store.append(graphId, {
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
      graph = this.store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'graph.resumed',
      });
    }
    return this.store.append(graphId, {
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
    let graph = this.requiredGraph(graphId);
    for (const item of evidence) {
      graph = this.store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'evidence.recorded',
        nodeId,
        data: { evidence: { ...item, nodeId: item.nodeId ?? nodeId } },
      });
    }
    return this.store.append(graphId, {
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
    let graph = this.requiredGraph(graphId);
    graph = this.store.append(graphId, {
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
      graph = this.store.append(graphId, {
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
    let graph = this.reconcile(graphId);
    const candidates = this.selectRunnable(graph);
    const started: ExecutionNode[] = [];
    for (const candidate of candidates) {
      graph = this.startNode(graphId, candidate.id);
      started.push(this.requiredNode(graph, candidate.id));
    }
    const settled = await Promise.all(
      started.map(async (node) => {
        try {
          return { node, result: await executor(node, graph) };
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
    for (const item of settled) {
      graph = item.result.success
        ? this.succeedNode(graphId, item.node.id, item.result.evidence)
        : this.failNode(graphId, item.node.id, {
            error: item.result.error ?? 'Node execution failed',
            ...(item.result.failureFingerprint
              ? { failureFingerprint: item.result.failureFingerprint }
              : {}),
          });
    }
    graph = this.reconcile(graphId);
    return { graph, startedNodeIds: started.map((node) => node.id) };
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
