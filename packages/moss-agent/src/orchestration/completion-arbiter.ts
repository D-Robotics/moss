import type {
  ExecutionEvidence,
  ExecutionGraphSnapshot,
  ExecutionStore,
  ExecutionVerification,
} from './execution-types.js';

/** Task-specific evidence policy selected by the trusted host. @beta */
export type CompletionTaskKind = 'coding' | 'research' | 'device' | 'analysis';

/** Semantic coverage result; it cannot override deterministic failures. @beta */
export interface SemanticCompletionResult {
  readonly covered: boolean;
  readonly reasons: readonly string[];
}

/** Optional model callback invoked only after deterministic conditions pass. @beta */
export type SemanticCompletionJudge = (
  graph: ExecutionGraphSnapshot
) => Promise<SemanticCompletionResult>;

/** Inputs that are not derivable from the graph event stream yet. @beta */
export interface CompletionArbiterInput {
  readonly taskKind: CompletionTaskKind;
  readonly activeBackgroundTaskIds?: readonly string[];
  readonly activeWorkspaceLeaseIds?: readonly string[];
  readonly semanticJudge?: SemanticCompletionJudge;
}

/** Unified completion outcome consumed by CLI, Web, TUI, and ACP. @beta */
export interface CompletionDecision {
  readonly status: 'in_progress' | 'blocked' | 'completed' | 'failed';
  readonly verdict: 'pending' | 'needs_evidence' | 'verified' | 'rejected';
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
}

function criterionEvidence(graph: ExecutionGraphSnapshot): Set<string> {
  return new Set(
    graph.evidence
      .map((evidence) => evidence.metadata?.criterion)
      .filter((criterion): criterion is string => typeof criterion === 'string')
  );
}

function evidenceOfKind(
  graph: ExecutionGraphSnapshot,
  kind: ExecutionEvidence['kind']
): ExecutionEvidence[] {
  return graph.evidence.filter((evidence) => evidence.kind === kind);
}

function deterministicDecision(
  graph: ExecutionGraphSnapshot,
  input: CompletionArbiterInput
): CompletionDecision {
  const reasons: string[] = [];
  if (input.activeBackgroundTaskIds?.length) {
    reasons.push(`Background tasks are still active: ${input.activeBackgroundTaskIds.join(', ')}`);
  }
  if (input.activeWorkspaceLeaseIds?.length) {
    reasons.push(`Workspace leases are still active: ${input.activeWorkspaceLeaseIds.join(', ')}`);
  }
  if (reasons.length > 0) {
    return { status: 'in_progress', verdict: 'pending', reasons, evidenceIds: [] };
  }

  const nodes = Object.values(graph.nodes);
  const rejectedNodes = nodes.filter((node) =>
    ['blocked', 'merge_conflict', 'cancelled'].includes(node.status)
  );
  if (rejectedNodes.length > 0) {
    return {
      status: 'failed',
      verdict: 'rejected',
      reasons: [`Terminal node failures: ${rejectedNodes.map((node) => node.id).join(', ')}`],
      evidenceIds: rejectedNodes.flatMap((node) => node.evidenceIds),
    };
  }
  const unfinished = nodes.filter(
    (node) => node.status !== 'succeeded' && node.status !== 'skipped'
  );
  if (unfinished.length > 0) {
    return {
      status: 'in_progress',
      verdict: 'pending',
      reasons: [`Unfinished nodes: ${unfinished.map((node) => node.id).join(', ')}`],
      evidenceIds: [],
    };
  }

  const requiredCriteria = [...new Set(nodes.flatMap((node) => node.acceptanceCriteria ?? []))];
  const coveredCriteria = criterionEvidence(graph);
  const missingCriteria = requiredCriteria.filter((criterion) => !coveredCriteria.has(criterion));
  if (missingCriteria.length > 0) {
    reasons.push(`Missing acceptance evidence: ${missingCriteria.join(', ')}`);
  }

  const evidenceIds = new Set<string>();
  if (input.taskKind === 'coding') {
    const patches = evidenceOfKind(graph, 'patch').filter(
      (evidence) => evidence.metadata?.merged === true
    );
    if (patches.length === 0) reasons.push('Coding completion requires merged patch evidence.');
    for (const patch of patches) evidenceIds.add(patch.id);
    const newestPatchAt = Math.max(...patches.map((patch) => patch.createdAt), 0);
    const verificationNodes = nodes.filter((node) => node.kind === 'verification');
    if (
      verificationNodes.length === 0 ||
      verificationNodes.some((node) => node.status !== 'succeeded')
    ) {
      reasons.push('Coding completion requires an independent successful verifier node.');
    }
    const fresh = evidenceOfKind(graph, 'verification').filter(
      (evidence) =>
        evidence.metadata?.fresh === true &&
        evidence.metadata?.exitCode === 0 &&
        evidence.createdAt > newestPatchAt
    );
    if (fresh.length === 0) {
      reasons.push('Coding completion requires fresh verification after the latest patch.');
    }
    for (const evidence of fresh) evidenceIds.add(evidence.id);
  } else if (input.taskKind === 'research') {
    const sources = graph.evidence.filter(
      (evidence) => evidence.kind === 'citation' || evidence.kind === 'tool_result'
    );
    if (sources.length === 0)
      reasons.push('Research completion requires citation or tool evidence.');
    for (const evidence of sources) evidenceIds.add(evidence.id);
  } else if (input.taskKind === 'device') {
    const probes = evidenceOfKind(graph, 'probe_receipt').filter(
      (evidence) => evidence.metadata?.real === true
    );
    if (probes.length === 0) reasons.push('Device completion requires a real probe receipt.');
    for (const evidence of probes) evidenceIds.add(evidence.id);
  } else {
    for (const evidence of graph.evidence) evidenceIds.add(evidence.id);
  }

  if (reasons.length > 0) {
    return {
      status: graph.policy.strictCompletion ? 'blocked' : 'in_progress',
      verdict: 'needs_evidence',
      reasons,
      evidenceIds: [...evidenceIds],
    };
  }
  return {
    status: 'completed',
    verdict: 'verified',
    reasons: [],
    evidenceIds: [...evidenceIds],
  };
}

/** Deterministic-first completion authority for one execution store. @beta */
export class CompletionArbiter {
  constructor(private readonly store: ExecutionStore) {}

  async decide(graphId: string, input: CompletionArbiterInput): Promise<CompletionDecision> {
    let graph = this.store.load(graphId);
    if (!graph) throw new Error(`unknown execution graph "${graphId}"`);
    let decision = deterministicDecision(graph, input);
    if (decision.verdict === 'verified' && input.semanticJudge) {
      const semantic = await input.semanticJudge(graph);
      if (!semantic.covered) {
        decision = {
          status: graph.policy.strictCompletion ? 'blocked' : 'in_progress',
          verdict: 'needs_evidence',
          reasons: [...semantic.reasons],
          evidenceIds: decision.evidenceIds,
        };
      }
    }
    if (decision.verdict === 'pending') return decision;
    const verifiedAt = Date.now();
    const verification: ExecutionVerification = {
      verdict: decision.verdict,
      evidenceIds: decision.evidenceIds,
      reasons: decision.reasons,
      verifiedAt,
    };
    graph = this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'verification.recorded',
      time: verifiedAt,
      data: { verification },
    });
    if (decision.status === 'completed') {
      this.store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'graph.completed',
        time: verifiedAt,
        data: { evidenceIds: decision.evidenceIds },
      });
    } else if (decision.status === 'blocked') {
      this.store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'graph.blocked',
        time: verifiedAt,
        data: { reason: 'needs_evidence', reasons: decision.reasons },
      });
    } else if (decision.status === 'failed') {
      this.store.append(graphId, {
        expectedRevision: graph.revision,
        type: 'graph.failed',
        time: verifiedAt,
        data: { reasons: decision.reasons },
      });
    }
    return decision;
  }
}
