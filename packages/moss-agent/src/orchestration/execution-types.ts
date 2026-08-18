/** Lifecycle of an authoritative long-running execution graph. @beta */
export type ExecutionGraphStatus =
  | 'paused'
  | 'ready'
  | 'running'
  | 'paused_recovered'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Kind of work represented by an execution node. @beta */
export type ExecutionNodeKind =
  | 'analysis'
  | 'implementation'
  | 'verification'
  | 'merge'
  | 'approval'
  | 'manual';

/** Lifecycle of one execution node. @beta */
export type ExecutionNodeStatus =
  | 'pending'
  | 'ready'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'interrupted'
  | 'merge_conflict'
  | 'cancelled';

/** Explicit resource limits. Omitted values are unlimited and never hidden. @beta */
export interface ExecutionBudget {
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxWallTimeMs?: number;
  readonly usedTokens?: number;
  readonly usedCostUsd?: number;
  readonly usedWallTimeMs?: number;
}

/** Scheduling and completion policy for one graph. @beta */
export interface OrchestrationPolicy {
  readonly maxConcurrency: number;
  readonly maxAttemptsPerNode: number;
  readonly strictCompletion: boolean;
  readonly autoResumeReadonly?: boolean;
}

/** Stable definition used to create one graph node. @beta */
export interface ExecutionNodeDefinition {
  readonly id: string;
  readonly kind: ExecutionNodeKind;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly roleId?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly budget?: ExecutionBudget;
}

/** Current projection of one graph node. @beta */
export interface ExecutionNode extends ExecutionNodeDefinition {
  readonly status: ExecutionNodeStatus;
  readonly attempts: number;
  readonly failureFingerprint?: string;
  readonly consecutiveSameFailures: number;
  readonly evidenceIds: readonly string[];
  readonly workspaceLeaseId?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
}

/** Evidence category retained without secret-bearing request or result bodies. @beta */
export type ExecutionEvidenceKind =
  | 'tool_result'
  | 'command_exit'
  | 'artifact_digest'
  | 'patch'
  | 'expert_claim'
  | 'approval'
  | 'verification'
  | 'probe_receipt'
  | 'citation';

/** One immutable evidence reference. @beta */
export interface ExecutionEvidence {
  readonly id: string;
  readonly kind: ExecutionEvidenceKind;
  readonly nodeId?: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  readonly artifactRef?: string;
  readonly digest?: string;
}

/** Evidence-bound graph verification verdict. @beta */
export interface ExecutionVerification {
  readonly verdict: 'verified' | 'rejected' | 'needs_evidence';
  readonly evidenceIds: readonly string[];
  readonly reasons: readonly string[];
  readonly verifiedAt: number;
}

/** Recovery facts surfaced after a host restart. @beta */
export interface ExecutionRecovery {
  readonly recoveredAt: number;
  readonly requiresUserResume: boolean;
  readonly interruptedNodeIds: readonly string[];
  readonly blockedMutationNodeIds: readonly string[];
}

/** Current event-sourced task projection shared by all product surfaces. @beta */
export interface ExecutionGraphSnapshot {
  readonly id: string;
  readonly sessionId?: string;
  readonly goal: string;
  readonly status: ExecutionGraphStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly policy: OrchestrationPolicy;
  readonly budget: ExecutionBudget;
  readonly nodes: Readonly<Record<string, ExecutionNode>>;
  readonly evidence: readonly ExecutionEvidence[];
  readonly verification?: ExecutionVerification;
  readonly recovery?: ExecutionRecovery;
}

/** Ordered event kinds understood by the execution graph projector. @beta */
export type ExecutionEventType =
  | 'graph.created'
  | 'graph.ready'
  | 'graph.resumed'
  | 'graph.paused'
  | 'graph.recovered'
  | 'graph.blocked'
  | 'graph.completed'
  | 'graph.failed'
  | 'graph.cancelled'
  | 'plan.revised'
  | 'node.added'
  | 'node.ready'
  | 'node.leased'
  | 'node.started'
  | 'node.progressed'
  | 'node.succeeded'
  | 'node.failed'
  | 'node.interrupted'
  | 'node.retry_requested'
  | 'node.blocked'
  | 'node.skipped'
  | 'node.merge_conflict'
  | 'node.cancelled'
  | 'evidence.recorded'
  | 'budget.updated'
  | 'steering.recorded'
  | 'verification.recorded';

/** One immutable graph fact with a monotonic graph-local sequence. @beta */
export interface ExecutionEvent {
  readonly id: string;
  readonly graphId: string;
  readonly seq: number;
  readonly type: ExecutionEventType;
  readonly time: number;
  readonly nodeId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Input for creating an execution graph. @beta */
export interface CreateExecutionGraphInput {
  readonly id: string;
  readonly sessionId?: string;
  readonly goal: string;
  readonly nodes?: readonly ExecutionNodeDefinition[];
  readonly policy?: Partial<OrchestrationPolicy>;
  readonly budget?: ExecutionBudget;
  readonly now?: number;
}

/** Compare-and-set append request. @beta */
export interface AppendExecutionEventInput {
  readonly id?: string;
  readonly expectedRevision: number;
  readonly type: Exclude<ExecutionEventType, 'graph.created'>;
  readonly time?: number;
  readonly nodeId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Renewable local ownership lease for one graph. @beta */
export interface ExecutionOwnerLease {
  readonly graphId: string;
  readonly ownerId: string;
  readonly token: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

/** Owner lease acquisition options. @beta */
export interface AcquireExecutionLeaseInput {
  readonly ownerId: string;
  readonly ttlMs?: number;
}

/** Authoritative execution persistence seam. @beta */
export interface ExecutionStore {
  create(input: CreateExecutionGraphInput): ExecutionGraphSnapshot;
  load(graphId: string): ExecutionGraphSnapshot | undefined;
  list(): readonly ExecutionGraphSnapshot[];
  events(graphId: string, after?: number): readonly ExecutionEvent[];
  append(graphId: string, input: AppendExecutionEventInput): ExecutionGraphSnapshot;
  acquireLease(graphId: string, input: AcquireExecutionLeaseInput): ExecutionOwnerLease;
  renewLease(lease: ExecutionOwnerLease, ttlMs?: number): ExecutionOwnerLease;
  releaseLease(graphId: string, lease: ExecutionOwnerLease): void;
}
