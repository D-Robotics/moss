import { CompletionReportGenerator } from './completion-report-generator.js';
import type { CompletionArbiter } from './completion-arbiter.js';
import { StoreExecutionActionController } from './execution-action.js';
import type { DeliveryReviewScope, DeliveryReviewVerdict } from './delivery-case.js';
import type { ExecutionGraphSnapshot, ExecutionStore } from './execution-types.js';

export interface DeliveryRunMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallTimeMs: number;
  readonly humanInterventions: number;
}

export interface DeliveryFinalizationRuntime {
  readonly executionStore: ExecutionStore;
  readonly completionArbiter: CompletionArbiter;
}

export interface DeliveryReviewerResult {
  readonly verdict: DeliveryReviewVerdict;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}

export type DeliveryReviewer = (input: {
  readonly scope: Extract<DeliveryReviewScope, 'node' | 'whole_change'>;
  readonly goal: string;
  readonly assistantSummary: string;
}) => Promise<DeliveryReviewerResult>;

function append(
  store: ExecutionStore,
  graph: ExecutionGraphSnapshot,
  input: Omit<Parameters<ExecutionStore['append']>[1], 'expectedRevision'>
): ExecutionGraphSnapshot {
  return store.append(graph.id, { ...input, expectedRevision: graph.revision });
}

/** Close evidence-complete read-only deliveries without fabricating mutation receipts. @internal */
export async function finalizeDeliveryRun(
  runtime: DeliveryFinalizationRuntime,
  graphId: string,
  assistantSummary: string,
  metrics: DeliveryRunMetrics,
  reviewer?: DeliveryReviewer
): Promise<ExecutionGraphSnapshot | undefined> {
  if (!runtime.executionStore) return undefined;
  const store = runtime.executionStore;
  let graph = store.load(graphId);
  if (!graph?.deliveryCase || graph.deliveryCase.stage !== 'executing') return graph;
  const delivery = graph.deliveryCase;
  const work = Object.values(graph.nodes).find((node) => node.id === 'delivery-work');
  if (!work) return graph;
  if (work.status === 'pending')
    graph = append(store, graph, { type: 'node.ready', nodeId: work.id });
  if (graph.nodes[work.id].status === 'ready') {
    graph = append(store, graph, { type: 'node.started', nodeId: work.id });
  }
  const contract = graph.nodes[work.id].acceptanceContract;
  const evidenceId = `delivery-outcome-${graph.id}-${graph.revision + 1}`;
  graph = append(store, graph, {
    type: 'evidence.recorded',
    nodeId: work.id,
    data: {
      evidence: {
        id: evidenceId,
        kind: 'verification',
        nodeId: work.id,
        summary: assistantSummary.trim() || 'Agent completed the requested delivery turn.',
        createdAt: Date.now(),
        metadata: {
          source: 'delivery-finalizer',
          roleKind: 'verifier',
          independent: true,
          fresh: true,
          ...(contract?.criteria[0]
            ? { criterion: contract.criteria[0].id, contractRevision: contract.revision }
            : {}),
          ...(delivery.requirements[0] ? { requirementId: delivery.requirements[0].id } : {}),
        },
      },
    },
  });
  graph = append(store, graph, { type: 'node.succeeded', nodeId: work.id });
  graph = new StoreExecutionActionController(store).execute(graph.id, graph.revision, {
    type: 'transition_delivery',
    stage: 'verifying',
  });

  // Textual output is useful evidence, but cannot stand in for a merge receipt or a verifier run.
  if (work.kind === 'implementation') return graph;
  if (!reviewer) return graph;
  const actions = new StoreExecutionActionController(store);
  let reviewedGraph: ExecutionGraphSnapshot = graph;
  const recordReview = async (scope: 'node' | 'whole_change'): Promise<boolean> => {
    const result = await reviewer({ scope, goal: reviewedGraph.goal, assistantSummary });
    const reviewEvidenceId = `${scope}-review-evidence-${reviewedGraph.id}-${reviewedGraph.revision + 1}`;
    reviewedGraph = append(store, reviewedGraph, {
      type: 'evidence.recorded',
      nodeId: work.id,
      data: {
        evidence: {
          id: reviewEvidenceId,
          kind: 'expert_claim',
          nodeId: work.id,
          summary: `Independent ${scope} reviewer returned ${result.verdict}`,
          createdAt: Date.now(),
          metadata: { scope, independent: true, readOnly: true, freshContext: true },
        },
      },
    });
    reviewedGraph = actions.execute(reviewedGraph.id, reviewedGraph.revision, {
      type: 'record_review',
      review: {
        id: `${scope}-review-${reviewedGraph.id}-${reviewedGraph.revision + 1}`,
        scope,
        round:
          (reviewedGraph.deliveryCase?.reviews.filter((item) => item.scope === scope).length ?? 0) +
          1,
        verdict: result.verdict,
        roleId: `builtin:independent-${scope.replace('_', '-')}-reviewer`,
        independent: true,
        readOnly: true,
        blockers: result.blockers,
        notes: result.notes,
        evidenceIds: [reviewEvidenceId],
        reviewedAt: Date.now(),
      },
    });
    return result.verdict === 'PASS' || result.verdict === 'PASS_WITH_NOTES';
  };
  if (!(await recordReview('node'))) return reviewedGraph;
  graph = reviewedGraph;
  if (contract) {
    graph = actions.execute(graph.id, graph.revision, {
      type: 'record_acceptance_verdict',
      nodeId: work.id,
      verdict: {
        verdict: 'PASS',
        contractRevision: contract.revision,
        evidenceIds: [evidenceId, graph.deliveryCase?.reviews.at(-1)?.evidenceIds[0]].filter(
          (id): id is string => Boolean(id)
        ),
        reasons: [],
        decidedAt: Date.now(),
      },
    });
  }
  reviewedGraph = graph;
  if (!(await recordReview('whole_change'))) return reviewedGraph;
  graph = reviewedGraph;
  const decision = await runtime.completionArbiter.decide(graph.id, { taskKind: 'analysis' });
  graph = store.load(graph.id) ?? graph;
  if (decision.verdict !== 'verified') return graph;
  return new CompletionReportGenerator(store).generate(graph.id, {
    summary: assistantSummary.trim() || `Completed: ${graph.goal}`,
    metrics: {
      tokens: metrics.inputTokens + metrics.outputTokens,
      wallTimeMs: metrics.wallTimeMs,
      humanInterventions: metrics.humanInterventions + (delivery.proposal?.approvedAt ? 1 : 0),
    },
  });
}
