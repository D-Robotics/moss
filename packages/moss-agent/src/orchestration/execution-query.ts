import type {
  ExecutionBudget,
  ExecutionEvent,
  ExecutionEvidence,
  ExecutionGraphSnapshot,
  ExecutionNode,
  ExecutionRecovery,
  ExecutionStore,
  ExecutionVerification,
} from './execution-types.js';
import type { CompletionReport, DeliveryCaseSnapshot, DeliveryReview } from './delivery-case.js';

/** Host-neutral projection consumed by Web, CLI, TUI, ACP, and plugins. @beta */
export interface ExecutionView {
  readonly graphId: string;
  readonly sessionId?: string;
  readonly goal: string;
  readonly status: ExecutionGraphSnapshot['status'];
  readonly revision: number;
  readonly updatedAt: number;
  readonly budget: ExecutionBudget;
  readonly nodes: readonly ExecutionNode[];
  readonly evidence: readonly ExecutionEvidence[];
  readonly patches: readonly ExecutionEvidence[];
  readonly conflicts: readonly ExecutionNode[];
  readonly roleNodeIds: Readonly<Record<string, readonly string[]>>;
  readonly verification?: ExecutionVerification;
  readonly recovery?: ExecutionRecovery;
  readonly deliveryCase?: DeliveryCaseSnapshot;
  readonly reviews: readonly DeliveryReview[];
  readonly completionReport?: CompletionReport;
}

/** Filters shared across product-surface execution listings. @beta */
export interface ExecutionQueryFilter {
  readonly sessionId?: string;
  readonly status?: ExecutionGraphSnapshot['status'];
}

/** Incremental update with graph-local sequence continuity. @beta */
export interface ExecutionUpdate {
  readonly graphId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly events: readonly ExecutionEvent[];
  readonly view: ExecutionView;
}

/** Subscription controls for a local execution graph. @beta */
export interface ExecutionSubscriptionOptions {
  readonly afterRevision?: number;
  readonly signal?: AbortSignal;
}

/** Stable read seam for every Moss product surface. @beta */
export interface ExecutionQuery {
  get(graphId: string): ExecutionView | undefined;
  list(filter?: ExecutionQueryFilter): readonly ExecutionView[];
  events(graphId: string, afterRevision?: number): readonly ExecutionEvent[];
  subscribe(
    graphId: string,
    options?: ExecutionSubscriptionOptions
  ): AsyncIterableIterator<ExecutionUpdate>;
}

/** Store-backed execution-query adapter with bounded local polling. @beta */
export class StoreExecutionQuery implements ExecutionQuery {
  private readonly pollIntervalMs: number;

  constructor(
    private readonly store: ExecutionStore,
    options: { readonly pollIntervalMs?: number } = {}
  ) {
    this.pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? 100));
  }

  get(graphId: string): ExecutionView | undefined {
    const graph = this.store.load(graphId);
    return graph ? this.project(graph) : undefined;
  }

  list(filter: ExecutionQueryFilter = {}): readonly ExecutionView[] {
    return this.store
      .list()
      .filter((graph) => !filter.sessionId || graph.sessionId === filter.sessionId)
      .filter((graph) => !filter.status || graph.status === filter.status)
      .map((graph) => this.project(graph));
  }

  events(graphId: string, afterRevision = 0): readonly ExecutionEvent[] {
    return this.store.events(graphId, afterRevision);
  }

  async *subscribe(
    graphId: string,
    options: ExecutionSubscriptionOptions = {}
  ): AsyncIterableIterator<ExecutionUpdate> {
    let cursor = options.afterRevision ?? 0;
    while (!options.signal?.aborted) {
      const events = this.store.events(graphId, cursor);
      if (events.length > 0) {
        const view = this.get(graphId);
        if (!view) return;
        const fromRevision = cursor;
        cursor = events.at(-1)?.seq ?? cursor;
        yield { graphId, fromRevision, toRevision: cursor, events, view };
        continue;
      }
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, this.pollIntervalMs);
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private project(graph: ExecutionGraphSnapshot): ExecutionView {
    const nodes = Object.values(graph.nodes);
    const roleNodeIds: Record<string, string[]> = {};
    for (const node of nodes) {
      if (!node.roleId) continue;
      (roleNodeIds[node.roleId] ??= []).push(node.id);
    }
    return {
      graphId: graph.id,
      ...(graph.sessionId ? { sessionId: graph.sessionId } : {}),
      goal: graph.goal,
      status: graph.status,
      revision: graph.revision,
      updatedAt: graph.updatedAt,
      budget: graph.budget,
      nodes,
      evidence: graph.evidence,
      patches: graph.evidence.filter((evidence) => evidence.kind === 'patch'),
      conflicts: nodes.filter((node) => node.status === 'merge_conflict'),
      roleNodeIds,
      ...(graph.verification ? { verification: graph.verification } : {}),
      ...(graph.recovery ? { recovery: graph.recovery } : {}),
      ...(graph.deliveryCase
        ? {
            deliveryCase: graph.deliveryCase,
            reviews: graph.deliveryCase.reviews,
            ...(graph.deliveryCase.completionReport
              ? { completionReport: graph.deliveryCase.completionReport }
              : {}),
          }
        : { reviews: [] }),
    };
  }
}
