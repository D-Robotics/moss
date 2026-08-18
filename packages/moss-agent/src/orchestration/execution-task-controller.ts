import { ErrorCode, MossError } from '../errors.js';
import type { ExecutionGraphSnapshot, ExecutionStore } from './execution-types.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Product-neutral control plane shared by CLI, Web, TUI, and ACP. @beta */
export class ExecutionTaskController {
  constructor(private readonly store: ExecutionStore) {}

  list(): readonly ExecutionGraphSnapshot[] {
    return this.store.list();
  }

  inspect(graphId: string): ExecutionGraphSnapshot {
    return this.required(graphId);
  }

  resume(graphId: string): ExecutionGraphSnapshot {
    const graph = this.required(graphId);
    if (TERMINAL.has(graph.status)) this.invalid(`task "${graphId}" is ${graph.status}`);
    return this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'graph.resumed',
      data: { recoveryAcknowledged: graph.status === 'paused_recovered' },
    });
  }

  retry(graphId: string, nodeId: string): ExecutionGraphSnapshot {
    const graph = this.required(graphId);
    if (!graph.nodes[nodeId]) this.invalid(`unknown task node "${nodeId}"`);
    return this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'node.retry_requested',
      nodeId,
      data: { requestedBy: 'user' },
    });
  }

  stop(graphId: string): ExecutionGraphSnapshot {
    const graph = this.required(graphId);
    if (TERMINAL.has(graph.status)) return graph;
    return this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'graph.cancelled',
      data: { requestedBy: 'user' },
    });
  }

  private required(graphId: string): ExecutionGraphSnapshot {
    const graph = this.store.load(graphId);
    if (!graph) this.invalid(`unknown task "${graphId}"`);
    return graph;
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }
}
