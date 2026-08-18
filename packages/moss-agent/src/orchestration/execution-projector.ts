import { ErrorCode, MossError } from '../errors.js';
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
    ...(definition.acceptanceCriteria
      ? { acceptanceCriteria: [...definition.acceptanceCriteria] }
      : {}),
    ...(definition.budget ? { budget: { ...definition.budget } } : {}),
    status: 'pending',
    attempts: 0,
    consecutiveSameFailures: 0,
    evidenceIds: [],
  };
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
  for (const node of Object.values(nodes)) {
    for (const dependency of node.dependencies) {
      if (!nodes[dependency])
        throw invalid(`node "${node.id}" depends on unknown node "${dependency}"`);
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

/** Project and validate an ordered event stream. @beta */
export function projectExecutionGraph(events: readonly ExecutionEvent[]): ExecutionGraphSnapshot {
  const first = events[0];
  if (!first || first.type !== 'graph.created' || first.seq !== 1) {
    throw invalid('execution graph must start with graph.created at sequence 1');
  }
  let snapshot = createdSnapshot(first);
  for (const event of events.slice(1)) {
    if (event.graphId !== snapshot.id || event.seq !== snapshot.revision + 1) {
      throw invalid(`invalid execution event sequence ${event.seq}`);
    }
    if (event.type === 'node.added') {
      const raw = event.data.node;
      if (!raw || typeof raw !== 'object') throw invalid('node.added requires node');
      const node = normalizeNode(raw as ExecutionNodeDefinition);
      if (snapshot.nodes[node.id]) throw invalid(`duplicate execution node "${node.id}"`);
      snapshot = { ...snapshot, nodes: { ...snapshot.nodes, [node.id]: node } };
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
      if (graphStatus) snapshot = { ...snapshot, status: graphStatus };
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
    },
  };
}

export function eventStringArray(event: ExecutionEvent, field: string): readonly string[] {
  return stringArray(event.data[field]);
}
