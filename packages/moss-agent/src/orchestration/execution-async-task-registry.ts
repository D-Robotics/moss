import type {
  MossAsyncTaskCompletion,
  MossAsyncTaskHandle,
  MossAsyncTaskRegistry,
  MossAsyncTaskResult,
  MossAsyncTaskRunner,
  MossAsyncTaskSnapshot,
  MossAsyncTaskStartRequest,
  MossAsyncTaskStatus,
  MossAsyncTaskStopReason,
  MossAsyncTaskUpdate,
} from '@rdk-moss/core/contracts/async-task';
import type { ExecutionGraphSnapshot, ExecutionStore } from './execution-types.js';

const NODE_ID = 'background-task';

function graphId(taskId: string): string {
  return `async_${Buffer.from(taskId, 'utf8').toString('base64url')}`;
}

function append(
  store: ExecutionStore,
  graph: ExecutionGraphSnapshot,
  type: Parameters<ExecutionStore['append']>[1]['type'],
  data: Readonly<Record<string, unknown>> = {}
): ExecutionGraphSnapshot {
  return store.append(graph.id, {
    expectedRevision: graph.revision,
    type,
    nodeId: type.startsWith('node.') ? NODE_ID : undefined,
    data,
  });
}

/** Async-task compatibility adapter backed by durable graph facts. @internal */
export class ExecutionBackedAsyncTaskRegistry implements MossAsyncTaskRegistry {
  constructor(
    private readonly delegate: MossAsyncTaskRegistry,
    private readonly store: ExecutionStore
  ) {}

  start<TPayload = unknown, TData = unknown>(
    request: MossAsyncTaskStartRequest<TPayload>,
    runner: MossAsyncTaskRunner<TPayload, TData>,
    options?: { parentSignal?: AbortSignal }
  ): MossAsyncTaskHandle {
    const id = graphId(request.taskId);
    let graph = this.store.load(id);
    if (!graph) {
      graph = this.store.create({
        id,
        goal: request.label?.trim() || `${request.kind} background task`,
        nodes: [
          {
            id: NODE_ID,
            kind: request.kind === 'subagent' ? 'analysis' : 'manual',
            title: request.label?.trim() || request.taskId,
            dependencies: [],
          },
        ],
      });
      graph = append(this.store, graph, 'graph.resumed');
      graph = append(this.store, graph, 'node.ready');
      append(this.store, graph, 'node.started');
    }
    const wrapped: MossAsyncTaskRunner<TPayload, TData> = async (input, signal) => {
      try {
        const result = await runner(input, signal);
        this.finish(request.taskId, result);
        return result;
      } catch (error) {
        this.fail(request.taskId, error);
        throw error;
      }
    };
    return this.delegate.start(request, wrapped, options);
  }

  update<TPayload = unknown>(
    taskId: string,
    patch: MossAsyncTaskUpdate<TPayload>
  ): MossAsyncTaskSnapshot | undefined {
    const snapshot = this.delegate.update(taskId, patch);
    const graph = this.store.load(graphId(taskId));
    if (graph && graph.nodes[NODE_ID]?.status === 'running') {
      append(this.store, graph, 'node.progressed', {
        phase: patch.progress?.phase ?? null,
        currentTurn: patch.progress?.currentTurn ?? null,
        toolCalls: patch.progress?.toolCalls ?? null,
      });
    }
    return snapshot;
  }

  status(taskId: string): MossAsyncTaskSnapshot | undefined {
    return this.delegate.status(taskId);
  }

  list(filter?: { parentTaskId?: string; status?: MossAsyncTaskStatus }): MossAsyncTaskSnapshot[] {
    return this.delegate.list(filter);
  }

  stop(
    taskId: string,
    reason: Exclude<MossAsyncTaskStopReason, 'timeout'> = 'user_cancelled'
  ): boolean {
    const stopped = this.delegate.stop(taskId, reason);
    if (!stopped) return false;
    let graph = this.store.load(graphId(taskId));
    if (
      graph &&
      ['running', 'ready', 'leased', 'pending', 'interrupted'].includes(
        graph.nodes[NODE_ID]?.status ?? ''
      )
    ) {
      graph = append(this.store, graph, 'node.cancelled', { reason });
      append(this.store, graph, 'graph.cancelled', { reason });
    }
    return true;
  }

  stopAll(
    reason: Exclude<MossAsyncTaskStopReason, 'timeout'> = 'user_cancelled'
  ): Promise<MossAsyncTaskCompletion[]> {
    for (const task of this.delegate.list()) this.stop(task.taskId, reason);
    return this.delegate.stopAll?.(reason) ?? Promise.resolve([]);
  }

  wait<TData = unknown>(taskId: string): Promise<MossAsyncTaskCompletion<TData>> {
    return this.delegate.wait(taskId);
  }

  readCompletion<TData = unknown>(taskId: string): MossAsyncTaskCompletion<TData> | undefined {
    return this.delegate.readCompletion(taskId);
  }

  private finish(taskId: string, result: MossAsyncTaskResult): void {
    let graph = this.store.load(graphId(taskId));
    if (!graph || graph.nodes[NODE_ID]?.status !== 'running') return;
    graph = append(this.store, graph, 'evidence.recorded', {
      evidence: {
        id: `async-result-${graph.revision + 1}`,
        kind: 'tool_result',
        nodeId: NODE_ID,
        summary: result.success ? 'background task succeeded' : 'background task reported failure',
        createdAt: Date.now(),
        metadata: { success: result.success },
      },
    });
    graph = append(
      this.store,
      graph,
      result.success ? 'node.succeeded' : 'node.failed',
      result.success ? {} : { error: 'background task reported failure' }
    );
    append(this.store, graph, result.success ? 'graph.completed' : 'graph.failed');
  }

  private fail(taskId: string, error: unknown): void {
    let graph = this.store.load(graphId(taskId));
    if (!graph || graph.nodes[NODE_ID]?.status !== 'running') return;
    graph = append(this.store, graph, 'node.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    append(this.store, graph, 'graph.failed');
  }
}
