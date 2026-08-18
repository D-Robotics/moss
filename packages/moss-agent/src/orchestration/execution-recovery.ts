import type { ExecutionGraphSnapshot, ExecutionStore } from './execution-types.js';

/** Fail-closed restart recovery options. @beta */
export interface RecoverExecutionGraphOptions {
  readonly now?: number;
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
  if (graph.status === 'completed' || graph.status === 'failed' || graph.status === 'cancelled') {
    return graph;
  }
  const now = options.now ?? Date.now();
  const interruptedNodeIds: string[] = [];
  const blockedMutationNodeIds: string[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== 'ready' && node.status !== 'leased' && node.status !== 'running') continue;
    graph = store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'node.interrupted',
      nodeId: node.id,
      time: now,
      data: { reason: 'host_restarted' },
    });
    interruptedNodeIds.push(node.id);
    if (node.kind !== 'analysis' && node.kind !== 'verification') {
      graph = store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'node.blocked',
        nodeId: node.id,
        time: now,
        data: { error: 'Interrupted mutation requires explicit inspection before retry.' },
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
  });
}
