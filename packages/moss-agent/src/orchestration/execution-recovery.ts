import type { ExecutionGraphSnapshot, ExecutionStore } from './execution-types.js';
import type { ExecutionOwnerLease } from './execution-types.js';

/** Fail-closed restart recovery options. @beta */
export interface RecoverExecutionGraphOptions {
  readonly now?: number;
  readonly ownerLease?: ExecutionOwnerLease;
}

/**
 * Interrupt active nodes and move an unfinished graph to `paused_recovered`.
 * External mutations are never replayed by this operation.
 * @beta
 */
export function recoverExecutionGraph(
  store: ExecutionStore,
  graphId: string,
  options: RecoverExecutionGraphOptions = {}
): ExecutionGraphSnapshot {
  let graph = store.load(graphId);
  if (!graph) throw new Error(`unknown execution graph "${graphId}"`);
  if (graph.status !== 'running' && graph.status !== 'ready') {
    return graph;
  }
  const now = options.now ?? Date.now();
  const interruptedNodeIds: string[] = [];
  const blockedMutationNodeIds: string[] = [];
  for (const node of Object.values(graph.nodes)) {
    // Ready work has not started and is safe to keep queued across a restart. Only
    // nodes which may have been executing need interruption classification.
    if (node.status !== 'leased' && node.status !== 'running') continue;
    graph = store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'node.interrupted',
      nodeId: node.id,
      time: now,
      data: { reason: 'host_restarted' },
      ownerLease: options.ownerLease,
    });
    interruptedNodeIds.push(node.id);
    if (node.kind !== 'analysis' && node.kind !== 'verification') {
      graph = store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'node.blocked',
        nodeId: node.id,
        time: now,
        data: { error: 'Interrupted mutation requires explicit inspection before retry.' },
        ownerLease: options.ownerLease,
      });
      blockedMutationNodeIds.push(node.id);
    }
  }
  return store.append(graphId, {
    expectedRevision: graph.revision,
    type: 'graph.recovered',
    time: now,
    data: {
      recovery: {
        recoveredAt: now,
        requiresUserResume: true,
        interruptedNodeIds,
        blockedMutationNodeIds,
      },
    },
    ownerLease: options.ownerLease,
  });
}
