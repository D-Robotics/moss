import { ErrorCode, MossError } from '../errors.js';
import {
  normalizeAcceptanceContract,
  requireMutatingAcceptanceContract,
} from './acceptance-contract.js';
import type { AcceptanceVerdict } from './acceptance-contract.js';
import { applyDeliveryCaseEvent, createDeliveryCaseSnapshot } from './delivery-case.js';
import type { CompletionReport } from './delivery-case.js';
import type {
  ExecutionBudget,
  ExecutionEvent,
  ExecutionEvidence,
  ExecutionEventType,
  ExecutionGraphSnapshot,
  ExecutionNode,
  ExecutionNodeDefinition,
  ExecutionNodeStatus,
  ExecutionRecovery,
  ExecutionVerification,
  OrchestrationPolicy,
} from './execution-types.js';

export const DEFAULT_ORCHESTRATION_POLICY: OrchestrationPolicy = {
  maxConcurrency: 4,
  maxAttemptsPerNode: 3,
  strictCompletion: true,
  autoResumeReadonly: false,
};

const NODE_TRANSITIONS: Readonly<Record<string, readonly ExecutionNodeStatus[]>> = {
  'node.ready': ['pending', 'interrupted', 'failed', 'blocked'],
  'node.leased': ['ready'],
  'node.started': ['ready', 'leased'],
  'node.succeeded': ['running'],
  'node.failed': ['running'],
  'node.interrupted': ['ready', 'leased', 'running'],
  'node.retry_requested': ['failed', 'interrupted'],
  'node.blocked': ['pending', 'ready', 'leased', 'running', 'failed', 'interrupted'],
  'node.skipped': ['pending', 'ready', 'blocked'],
  'node.merge_conflict': ['running', 'succeeded'],
  'node.cancelled': ['pending', 'ready', 'leased', 'running', 'blocked', 'interrupted'],
};

function assertCompletionReportTraceability(
  snapshot: ExecutionGraphSnapshot,
  report: CompletionReport
): void {
  const delivery = snapshot.deliveryCase;
  if (!delivery) throw invalid('completion report requires a delivery case');
  const evidenceIds = new Set(snapshot.evidence.map((evidence) => evidence.id));
  const coverageByRequirement = new Map(
    report.requirementCoverage.map((coverage) => [coverage.requirementId, coverage])
  );
  for (const requirement of delivery.requirements.filter((item) => item.required)) {
    const coverage = coverageByRequirement.get(requirement.id);
    if (!coverage?.covered || coverage.evidenceIds.length === 0) {
      throw invalid(`completion report lacks evidence for requirement "${requirement.id}"`);
    }
    if (coverage.evidenceIds.some((id) => !evidenceIds.has(id))) {
      throw invalid(`completion report references unknown requirement evidence`);
    }
  }
  const reviewIds = new Set(delivery.reviews.map((review) => review.id));
  const latestWholeChangeReview = [...delivery.reviews]
    .reverse()
    .find((review) => review.scope === 'whole_change');
  if (
    !latestWholeChangeReview ||
    !report.reviewIds.includes(latestWholeChangeReview.id) ||
    report.reviewIds.some((id) => !reviewIds.has(id))
  ) {
    throw invalid('completion report references unknown review evidence');
  }
  if (
    report.verificationEvidenceIds.some((id) => !snapshot.verification?.evidenceIds.includes(id))
  ) {
    throw invalid('completion report references stale verification evidence');
  }
  const decisionIds = new Set(delivery.decisions.map((decision) => decision.id));
  if (report.decisions.some((id) => !decisionIds.has(id))) {
    throw invalid('completion report references unknown decisions');
  }
}

const GRAPH_TRANSITIONS: Readonly<
  Partial<Record<ExecutionEventType, readonly ExecutionGraphSnapshot['status'][]>>
> = {
  'graph.ready': ['paused'],
  'graph.resumed': ['paused', 'paused_recovered', 'ready', 'blocked'],
  'graph.paused': ['ready', 'running', 'blocked'],
  'graph.recovered': ['paused', 'ready', 'running', 'blocked'],
  'graph.blocked': ['paused', 'ready', 'running', 'paused_recovered'],
  'graph.completed': ['running', 'blocked'],
  'graph.failed': ['running', 'blocked'],
  'graph.cancelled': ['paused', 'ready', 'running', 'paused_recovered', 'blocked'],
};

function invalid(message: string): MossError {
  return new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw invalid(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizePolicy(raw: unknown): OrchestrationPolicy {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    maxConcurrency: Math.min(8, positiveInteger(value.maxConcurrency, 4)),
    maxAttemptsPerNode: positiveInteger(value.maxAttemptsPerNode, 3),
    strictCompletion: value.strictCompletion !== false,
    autoResumeReadonly: value.autoResumeReadonly === true,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    : [];
}

function normalizeNode(definition: ExecutionNodeDefinition): ExecutionNode {
  const acceptanceContract = normalizeAcceptanceContract(
    definition.acceptanceContract ?? definition.acceptanceCriteria
  );
  const mutating = definition.kind === 'implementation' && (definition.writePaths?.length ?? 0) > 0;
  const requiresAcceptanceMigration = definition.requiresAcceptanceMigration === true;
  if (requiresAcceptanceMigration && (!mutating || acceptanceContract)) {
    throw invalid(`node "${definition.id}" has an invalid legacy acceptance migration marker`);
  }
  if (mutating && !requiresAcceptanceMigration) {
    requireMutatingAcceptanceContract(definition.id, acceptanceContract);
  }
  return {
    id: requiredString(definition.id, 'node.id'),
    kind: definition.kind,
    title: requiredString(definition.title, 'node.title'),
    dependencies: [...definition.dependencies],
    ...(definition.roleId ? { roleId: definition.roleId } : {}),
    ...(definition.requiredCapabilities
      ? { requiredCapabilities: [...definition.requiredCapabilities] }
      : {}),
    ...(definition.writePaths ? { writePaths: [...definition.writePaths] } : {}),
    ...(acceptanceContract
      ? {
          acceptanceContract,
          acceptanceCriteria: acceptanceContract.criteria.map((criterion) => criterion.description),
        }
      : {}),
    ...(requiresAcceptanceMigration ? { requiresAcceptanceMigration: true } : {}),
    ...(definition.budget ? { budget: { ...definition.budget } } : {}),
    status: 'pending',
    attempts: 0,
    consecutiveSameFailures: 0,
    evidenceIds: [],
  };
}

function assertValidNodeGraph(nodes: Readonly<Record<string, ExecutionNode>>): void {
  for (const node of Object.values(nodes)) {
    for (const dependency of node.dependencies) {
      if (!nodes[dependency]) {
        throw invalid(`node "${node.id}" depends on unknown node "${dependency}"`);
      }
      if (dependency === node.id) throw invalid(`node "${node.id}" cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw invalid(`dependency cycle includes node "${nodeId}"`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of nodes[nodeId].dependencies) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of Object.keys(nodes)) visit(nodeId);
}

function createdSnapshot(event: ExecutionEvent): ExecutionGraphSnapshot {
  const rawNodes = Array.isArray(event.data.nodes)
    ? (event.data.nodes as ExecutionNodeDefinition[])
    : [];
  const nodes: Record<string, ExecutionNode> = {};
  for (const definition of rawNodes) {
    const node = normalizeNode(definition);
    if (nodes[node.id]) throw invalid(`duplicate execution node "${node.id}"`);
    nodes[node.id] = node;
  }
  assertValidNodeGraph(nodes);
  return {
    id: event.graphId,
    ...(typeof event.data.sessionId === 'string' ? { sessionId: event.data.sessionId } : {}),
    goal: requiredString(event.data.goal, 'goal'),
    status: 'paused',
    revision: event.seq,
    createdAt: event.time,
    updatedAt: event.time,
    policy: normalizePolicy(event.data.policy),
    budget:
      event.data.budget && typeof event.data.budget === 'object'
        ? { ...(event.data.budget as ExecutionBudget) }
        : {},
    nodes,
    evidence: [],
    ...(event.data.deliveryCase && typeof event.data.deliveryCase === 'object'
      ? {
          deliveryCase: createDeliveryCaseSnapshot(
            event.graphId,
            event.data.deliveryCase as import('./delivery-case.js').CreateDeliveryCaseInput
          ),
        }
      : {}),
  };
}

function requireNode(snapshot: ExecutionGraphSnapshot, event: ExecutionEvent): ExecutionNode {
  if (!event.nodeId) throw invalid(`${event.type} requires nodeId`);
  const node = snapshot.nodes[event.nodeId];
  if (!node) throw invalid(`unknown execution node "${event.nodeId}"`);
  return node;
}

function nodeStatusFor(event: ExecutionEvent): ExecutionNodeStatus | undefined {
  const suffix = event.type.startsWith('node.') ? event.type.slice(5) : '';
  if (suffix === 'retry_requested') return 'ready';
  if (
    suffix === 'ready' ||
    suffix === 'leased' ||
    suffix === 'started' ||
    suffix === 'succeeded' ||
    suffix === 'failed' ||
    suffix === 'interrupted' ||
    suffix === 'blocked' ||
    suffix === 'skipped' ||
    suffix === 'merge_conflict' ||
    suffix === 'cancelled'
  ) {
    return suffix === 'started' ? 'running' : suffix;
  }
  return undefined;
}

function applyNodeEvent(
  snapshot: ExecutionGraphSnapshot,
  event: ExecutionEvent
): ExecutionGraphSnapshot {
  const current = requireNode(snapshot, event);
  const allowed = NODE_TRANSITIONS[event.type];
  const target = nodeStatusFor(event);
  if (!allowed || !target) return snapshot;
  if (!allowed.includes(current.status)) {
    throw invalid(`node "${current.id}" cannot transition from ${current.status} to ${target}`);
  }
  const fingerprint =
    typeof event.data.failureFingerprint === 'string' ? event.data.failureFingerprint : undefined;
  const sameFailure =
    event.type === 'node.failed' && fingerprint && fingerprint === current.failureFingerprint
      ? current.consecutiveSameFailures + 1
      : event.type === 'node.failed'
        ? 1
        : current.consecutiveSameFailures;
  const attempts = event.type === 'node.started' ? current.attempts + 1 : current.attempts;
  const next: ExecutionNode = {
    ...current,
    status: target,
    attempts,
    consecutiveSameFailures: sameFailure,
    ...(fingerprint ? { failureFingerprint: fingerprint } : {}),
    ...(typeof event.data.error === 'string' ? { error: event.data.error } : {}),
    ...(typeof event.data.workspaceLeaseId === 'string'
      ? { workspaceLeaseId: event.data.workspaceLeaseId }
      : {}),
    ...(event.type === 'node.blocked'
      ? { blockedByDependencies: stringArray(event.data.blockedByDependencies) }
      : {}),
    ...(event.type === 'node.ready' ? { blockedByDependencies: undefined, error: undefined } : {}),
    ...(event.type === 'node.started' ? { startedAt: event.time } : {}),
    ...(event.type === 'node.succeeded' || event.type === 'node.skipped'
      ? { completedAt: event.time }
      : {}),
  };
  return { ...snapshot, nodes: { ...snapshot.nodes, [current.id]: next } };
}

function parseEvidence(event: ExecutionEvent): ExecutionEvidence {
  const raw = event.data.evidence;
  if (!raw || typeof raw !== 'object') throw invalid('evidence.recorded requires evidence');
  const evidence = raw as ExecutionEvidence;
  return {
    ...evidence,
    id: requiredString(evidence.id, 'evidence.id'),
    summary: requiredString(evidence.summary, 'evidence.summary'),
    createdAt: Number.isFinite(evidence.createdAt) ? evidence.createdAt : event.time,
  };
}

function applyAcceptanceRevision(
  snapshot: ExecutionGraphSnapshot,
  event: ExecutionEvent
): ExecutionGraphSnapshot {
  const current = requireNode(snapshot, event);
  const raw = event.data.contract;
  if (!raw || typeof raw !== 'object') throw invalid('acceptance.revised requires contract');
  const contract = normalizeAcceptanceContract(
    raw as import('./acceptance-contract.js').AcceptanceContract
  );
  if (!contract) throw invalid('acceptance.revised requires contract');
  const currentRevision = current.acceptanceContract?.revision ?? 0;
  if (contract.revision !== currentRevision + 1) {
    throw invalid(
      `acceptance contract for node "${current.id}" must advance from revision ${currentRevision} to ${currentRevision + 1}`
    );
  }
  if (current.kind === 'implementation' && (current.writePaths?.length ?? 0) > 0) {
    requireMutatingAcceptanceContract(current.id, contract);
  }
  const nodes = {
    ...snapshot.nodes,
    [current.id]: {
      ...current,
      acceptanceContract: contract,
      acceptanceCriteria: contract.criteria.map((criterion) => criterion.description),
      requiresAcceptanceMigration: false,
      ...(current.acceptanceVerdict
        ? {
            acceptanceVerdict: {
              ...current.acceptanceVerdict,
              verdict: 'STALE' as const,
              reasons: [
                ...current.acceptanceVerdict.reasons,
                `Acceptance contract advanced to revision ${contract.revision}.`,
              ],
              decidedAt: event.time,
            },
          }
        : {}),
    },
  };
  const verification = snapshot.verification
    ? {
        ...snapshot.verification,
        verdict: 'stale' as const,
        reasons: [
          ...snapshot.verification.reasons,
          `Acceptance contract for node "${current.id}" advanced to revision ${contract.revision}.`,
        ],
        verifiedAt: event.time,
      }
    : undefined;
  return {
    ...snapshot,
    nodes,
    ...(verification ? { verification } : {}),
    ...(snapshot.status === 'completed' ? { status: 'running' as const } : {}),
  };
}

function applyAcceptanceVerdict(
  snapshot: ExecutionGraphSnapshot,
  event: ExecutionEvent
): ExecutionGraphSnapshot {
  const current = requireNode(snapshot, event);
  const contract = current.acceptanceContract;
  const raw = event.data.verdict;
  if (!contract || !raw || typeof raw !== 'object') {
    throw invalid('acceptance verdict requires a node contract and verdict');
  }
  const verdict = raw as AcceptanceVerdict;
  if (!['PASS', 'FAIL', 'PARTIAL', 'STALE'].includes(verdict.verdict)) {
    throw invalid('acceptance verdict is invalid');
  }
  if (verdict.contractRevision !== contract.revision) {
    throw invalid(
      `acceptance verdict for node "${current.id}" must reference contract revision ${contract.revision}`
    );
  }
  const graphEvidence = new Set(snapshot.evidence.map((evidence) => evidence.id));
  if (verdict.evidenceIds.some((evidenceId) => !graphEvidence.has(evidenceId))) {
    throw invalid(`acceptance verdict for node "${current.id}" references unknown evidence`);
  }
  if (verdict.verdict === 'PASS') {
    const selectedEvidence = snapshot.evidence.filter((evidence) =>
      verdict.evidenceIds.includes(evidence.id)
    );
    const missing = contract.criteria.filter(
      (criterion) =>
        criterion.required &&
        !selectedEvidence.some(
          (evidence) =>
            evidence.metadata?.contractRevision === contract.revision &&
            (evidence.metadata?.criterion === criterion.id ||
              evidence.metadata?.criterion === criterion.description)
        )
    );
    if (missing.length > 0) {
      throw invalid(
        `acceptance PASS for node "${current.id}" lacks evidence for: ${missing
          .map((criterion) => criterion.id)
          .join(', ')}`
      );
    }
  }
  return {
    ...snapshot,
    nodes: {
      ...snapshot.nodes,
      [current.id]: {
        ...current,
        acceptanceVerdict: {
          verdict: verdict.verdict,
          contractRevision: verdict.contractRevision,
          evidenceIds: [...new Set(verdict.evidenceIds)],
          reasons: verdict.reasons.map((reason) => requiredString(reason, 'verdict reason')),
          decidedAt: Number.isFinite(verdict.decidedAt) ? verdict.decidedAt : event.time,
        },
      },
    },
  };
}

/** Project and validate an ordered event stream. @beta */
export function projectExecutionGraph(events: readonly ExecutionEvent[]): ExecutionGraphSnapshot {
  const first = events[0];
  if (!first || first.type !== 'graph.created' || first.seq !== 1) {
    throw invalid('execution graph must start with graph.created at sequence 1');
  }
  let snapshot = createdSnapshot(first);
  const strictEventValidation = Number(first.data.schemaVersion ?? 1) >= 2;
  for (const event of events.slice(1)) {
    if (event.graphId !== snapshot.id || event.seq !== snapshot.revision + 1) {
      throw invalid(`invalid execution event sequence ${event.seq}`);
    }
    const graphTransition = GRAPH_TRANSITIONS[event.type];
    if (strictEventValidation && graphTransition && !graphTransition.includes(snapshot.status)) {
      throw invalid(`graph cannot transition from ${snapshot.status} via ${event.type}`);
    }
    if (event.type === 'node.added') {
      const raw = event.data.node;
      if (!raw || typeof raw !== 'object') throw invalid('node.added requires node');
      const node = normalizeNode(raw as ExecutionNodeDefinition);
      if (snapshot.nodes[node.id]) throw invalid(`duplicate execution node "${node.id}"`);
      const nodes = { ...snapshot.nodes, [node.id]: node };
      if (strictEventValidation) assertValidNodeGraph(nodes);
      snapshot = { ...snapshot, nodes };
    } else if (event.type.startsWith('node.') && event.type !== 'node.progressed') {
      snapshot = applyNodeEvent(snapshot, event);
    } else if (event.type === 'evidence.recorded') {
      const evidence = parseEvidence(event);
      if (!snapshot.evidence.some((item) => item.id === evidence.id)) {
        const nodes = { ...snapshot.nodes };
        if (evidence.nodeId && nodes[evidence.nodeId]) {
          nodes[evidence.nodeId] = {
            ...nodes[evidence.nodeId],
            evidenceIds: [...nodes[evidence.nodeId].evidenceIds, evidence.id],
          };
        }
        snapshot = { ...snapshot, nodes, evidence: [...snapshot.evidence, evidence] };
      }
    } else if (event.type.startsWith('delivery.')) {
      if (!snapshot.deliveryCase) throw invalid(`${event.type} requires a delivery case`);
      let nodes = snapshot.nodes;
      if (event.type === 'delivery.review_recorded') {
        const review = event.data.review as { verdict?: unknown; round?: unknown } | undefined;
        const rawFixNodes = Array.isArray(event.data.fixNodes)
          ? (event.data.fixNodes as ExecutionNodeDefinition[])
          : [];
        if (
          (review?.verdict === 'FAIL' || review?.verdict === 'PARTIAL') &&
          Number(review.round) < 3 &&
          rawFixNodes.length === 0
        ) {
          throw invalid(`${String(review.verdict)} delivery review requires fix nodes`);
        }
        if (rawFixNodes.length > 0) {
          const nextNodes = { ...nodes };
          for (const definition of rawFixNodes) {
            const node = normalizeNode(definition);
            if (nextNodes[node.id]) throw invalid(`duplicate execution node "${node.id}"`);
            nextNodes[node.id] = node;
          }
          assertValidNodeGraph(nextNodes);
          nodes = nextNodes;
        }
      }
      if (event.type === 'delivery.proposal_recorded') {
        const proposal = event.data.proposal as { nodeIds?: unknown } | undefined;
        const nodeIds = Array.isArray(proposal?.nodeIds) ? proposal.nodeIds : [];
        const unknownNodeIds = nodeIds.filter(
          (nodeId): nodeId is string => typeof nodeId !== 'string' || !nodes[nodeId]
        );
        if (unknownNodeIds.length > 0) {
          throw invalid(`delivery proposal references unknown execution nodes`);
        }
      }
      if (event.type === 'delivery.artifact_recorded') {
        const artifact = event.data.artifact as
          | { evidenceId?: unknown; requirementIds?: unknown; digest?: unknown }
          | undefined;
        if (
          typeof artifact?.evidenceId !== 'string' ||
          !snapshot.evidence.some((evidence) => evidence.id === artifact.evidenceId)
        ) {
          throw invalid('delivery artifact references unknown evidence');
        }
        const evidence = snapshot.evidence.find((item) => item.id === artifact.evidenceId);
        if (
          typeof artifact.digest === 'string' &&
          evidence?.digest &&
          artifact.digest !== evidence.digest
        ) {
          throw invalid('delivery artifact digest does not match its evidence');
        }
        if (
          Array.isArray(artifact.requirementIds) &&
          artifact.requirementIds.some(
            (requirementId) =>
              typeof requirementId !== 'string' ||
              !snapshot.deliveryCase?.requirements.some(
                (requirement) => requirement.id === requirementId
              )
          )
        ) {
          throw invalid('delivery artifact references unknown requirement');
        }
      }
      if (event.type === 'delivery.reported' && snapshot.verification?.verdict !== 'verified') {
        throw invalid('completion report requires a verified execution verdict');
      }
      if (event.type === 'delivery.reported') {
        const report = event.data.report;
        if (!report || typeof report !== 'object') {
          throw invalid('delivery report requires report');
        }
        assertCompletionReportTraceability(snapshot, report as CompletionReport);
      }
      const nextDeliveryCase = applyDeliveryCaseEvent(snapshot.deliveryCase, event);
      snapshot = {
        ...snapshot,
        nodes,
        ...(event.type === 'delivery.requirements_revised' && snapshot.verification
          ? {
              verification: {
                ...snapshot.verification,
                verdict: 'stale' as const,
                reasons: [
                  ...snapshot.verification.reasons,
                  'Delivery requirements changed after verification.',
                ],
                verifiedAt: event.time,
              },
            }
          : {}),
        deliveryCase: {
          ...nextDeliveryCase,
          revision: snapshot.deliveryCase.revision + 1,
        },
      };
    } else if (event.type === 'acceptance.revised') {
      snapshot = applyAcceptanceRevision(snapshot, event);
    } else if (event.type === 'acceptance.verdict_recorded') {
      snapshot = applyAcceptanceVerdict(snapshot, event);
    } else if (event.type === 'budget.updated') {
      snapshot = { ...snapshot, budget: { ...snapshot.budget, ...event.data } };
    } else if (event.type === 'verification.recorded') {
      const raw = event.data.verification;
      if (!raw || typeof raw !== 'object')
        throw invalid('verification.recorded requires verification');
      snapshot = { ...snapshot, verification: raw as ExecutionVerification };
    } else if (event.type === 'graph.recovered') {
      snapshot = {
        ...snapshot,
        status: 'paused_recovered',
        recovery: event.data.recovery as unknown as ExecutionRecovery,
      };
    } else {
      const graphStatuses: Partial<Record<ExecutionEventType, ExecutionGraphSnapshot['status']>> = {
        'graph.ready': 'ready',
        'graph.resumed': 'running',
        'graph.paused': 'paused',
        'graph.blocked': 'blocked',
        'graph.completed': 'completed',
        'graph.failed': 'failed',
        'graph.cancelled': 'cancelled',
      };
      const graphStatus = graphStatuses[event.type];
      if (graphStatus) {
        if (strictEventValidation && event.type === 'graph.resumed') {
          if (
            snapshot.deliveryCase &&
            snapshot.deliveryCase.depth !== 'minimal' &&
            snapshot.deliveryCase.stage !== 'executing' &&
            snapshot.deliveryCase.stage !== 'verifying'
          ) {
            throw invalid(
              `graph cannot resume while ${snapshot.deliveryCase.depth} delivery is ${snapshot.deliveryCase.stage}`
            );
          }
          const missingAcceptance = Object.values(snapshot.nodes).filter(
            (node) => node.requiresAcceptanceMigration
          );
          if (missingAcceptance.length > 0) {
            throw invalid(
              `graph cannot resume until legacy acceptance contracts are supplied for nodes: ${missingAcceptance
                .map(({ id }) => id)
                .join(', ')}`
            );
          }
        }
        if (strictEventValidation && event.type === 'graph.completed') {
          const unfinished = Object.values(snapshot.nodes).filter(
            (node) => node.status !== 'succeeded' && node.status !== 'skipped'
          );
          if (unfinished.length > 0) {
            throw invalid(
              `graph cannot complete with unfinished nodes: ${unfinished.map(({ id }) => id).join(', ')}`
            );
          }
          if (snapshot.policy.strictCompletion && snapshot.verification?.verdict !== 'verified') {
            throw invalid('strict graph completion requires a verified evidence verdict');
          }
        }
        const nodes =
          event.type === 'graph.cancelled'
            ? Object.fromEntries(
                Object.entries(snapshot.nodes).map(([id, node]) => [
                  id,
                  node.status === 'leased' || node.status === 'running'
                    ? { ...node, status: 'cancelled' as const }
                    : node,
                ])
              )
            : snapshot.nodes;
        snapshot = { ...snapshot, status: graphStatus, nodes };
      }
    }
    snapshot = { ...snapshot, revision: event.seq, updatedAt: event.time };
  }
  return snapshot;
}

export function createGraphCreatedEvent(
  input: import('./execution-types.js').CreateExecutionGraphInput,
  id: string
): ExecutionEvent {
  return {
    id,
    graphId: input.id,
    seq: 1,
    type: 'graph.created',
    time: input.now ?? Date.now(),
    data: {
      goal: input.goal,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      nodes: input.nodes ?? [],
      policy: { ...DEFAULT_ORCHESTRATION_POLICY, ...input.policy },
      budget: input.budget ?? {},
      ...(input.deliveryCase ? { deliveryCase: input.deliveryCase } : {}),
      schemaVersion: 2,
    },
  };
}

export function eventStringArray(event: ExecutionEvent, field: string): readonly string[] {
  return stringArray(event.data[field]);
}
