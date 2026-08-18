import type { AcceptanceContract, AcceptanceVerdict } from './acceptance-contract.js';
import type { CreateDeliveryCaseInput, DeliveryCaseSnapshot } from './delivery-case.js';

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
  readonly acceptanceContract?: AcceptanceContract;
  /** Marks a readable legacy mutation that must receive an acceptance contract before resume. */
  readonly requiresAcceptanceMigration?: boolean;
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
  readonly blockedByDependencies?: readonly string[];
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly acceptanceVerdict?: AcceptanceVerdict;
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
  readonly verdict: 'verified' | 'rejected' | 'needs_evidence' | 'stale';
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
  readonly deliveryCase?: DeliveryCaseSnapshot;
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
  | 'acceptance.revised'
  | 'acceptance.verdict_recorded'
  | 'delivery.elaboration_recorded'
  | 'delivery.elaboration_answered'
  | 'delivery.requirements_revised'
  | 'delivery.decision_recorded'
  | 'delivery.artifact_recorded'
  | 'delivery.proposal_recorded'
  | 'delivery.proposal_approved'
  | 'delivery.stage_changed'
  | 'delivery.review_recorded'
  | 'delivery.reported'
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
  readonly deliveryCase?: CreateDeliveryCaseInput;
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
  /** Current graph-owner lease required while a live owner holds the graph. */
  readonly ownerLease?: ExecutionOwnerLease;
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
  /** Bind the package-authorized arbiter and return its terminal append capability. */
  bindCompletionAuthority(authority: object, owner: object): ExecutionCompletionAppender;
  acquireLease(graphId: string, input: AcquireExecutionLeaseInput): ExecutionOwnerLease;
  renewLease(lease: ExecutionOwnerLease, ttlMs?: number): ExecutionOwnerLease;
  releaseLease(graphId: string, lease: ExecutionOwnerLease): void;
}

/** Instance-bound terminal append capability held by CompletionArbiter. @beta */
export type ExecutionCompletionAppender = (
  graphId: string,
  input: AppendExecutionEventInput
) => ExecutionGraphSnapshot;

/** Result returned by one scheduler-managed node execution. @beta */
export interface ExecutionNodeRunResult {
  readonly success: boolean;
  readonly evidence?: readonly ExecutionEvidence[];
  readonly error?: string;
  readonly failureFingerprint?: string;
}

/** Cancellation and ownership context for one scheduler-managed node execution. @beta */
export interface ExecutionNodeExecutionContext {
  /** Aborted when the graph is stopped/paused or its owner lease can no longer be renewed. */
  readonly signal: AbortSignal;
}

/** Executor callback used by the execution graph scheduler. @beta */
export type ExecutionNodeExecutor = (
  node: ExecutionNode,
  graph: ExecutionGraphSnapshot,
  context: ExecutionNodeExecutionContext
) => Promise<ExecutionNodeRunResult>;

/** Outcome of one scheduler admission cycle. @beta */
export interface ExecutionScheduleResult {
  readonly graph: ExecutionGraphSnapshot;
  readonly startedNodeIds: readonly string[];
}
