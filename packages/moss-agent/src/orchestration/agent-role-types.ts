import type { ExecutionBudget, ExecutionNodeExecutionContext } from './execution-types.js';
import type { WorkspaceLease } from './workspace-lease-types.js';

/** Root-orchestrated role category. Workers cannot delegate recursively. @beta */
export type AgentRoleKind = 'advisor' | 'implementer' | 'verifier';

/** Built-in capability vocabulary; plugins may add namespaced capability strings. @beta */
export type AgentCapability =
  | 'architecture'
  | 'code'
  | 'test'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'device'
  | 'research'
  | (string & {});

/** Host-trusted role definition contributed by Moss or a plugin. @beta */
export interface AgentRoleDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly kind: AgentRoleKind;
  readonly capabilities: readonly AgentCapability[];
  readonly instructions: string;
  readonly workspaceMode: 'shared-readonly' | 'isolated-write';
  readonly outputContract: 'structured-v1';
  readonly allowedTools?: readonly string[];
  readonly model?: string;
  readonly budget?: ExecutionBudget;
}

/** One bounded unit assigned by the root orchestrator. @beta */
export interface AssignmentSpec {
  readonly id: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly goal: string;
  readonly requiredRoleKind: AgentRoleKind;
  readonly requiredCapabilities: readonly AgentCapability[];
  readonly inputEvidenceIds: readonly string[];
  readonly dependencies: readonly string[];
  readonly writePaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly budget?: ExecutionBudget;
}

/** Immutable role snapshot bound to an assignment before plugin unload is possible. @beta */
export interface RoutedAssignment {
  readonly assignment: AssignmentSpec;
  readonly role: Readonly<AgentRoleDefinition>;
  /** Isolated workspace provisioned by the root for an implementation assignment. */
  readonly workspaceLease?: WorkspaceLease;
}

/** Structured claim emitted by an expert role. @beta */
export interface AgentClaim {
  readonly id: string;
  readonly subject: string;
  readonly conclusion: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly evidenceRefs: readonly string[];
}

/** Structured assignment result. Non-empty prose alone is not success. @beta */
export interface AgentResult {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly status: 'PASS' | 'FAIL' | 'PARTIAL';
  readonly claims: readonly AgentClaim[];
  readonly evidenceRefs: readonly string[];
  /** Adapter-owned patch ID produced from the routed workspace lease. */
  readonly patchRef?: string;
  /** Machine receipt returned only by a trusted verifier executor. */
  readonly verification?: AgentVerificationReceipt;
  readonly unmetCriteria: readonly string[];
  readonly runId?: string;
}

/** Fresh command receipt produced by a trusted verifier executor. @beta */
export interface AgentVerificationReceipt {
  readonly command: string;
  readonly exitCode: number;
  readonly summary: string;
  readonly artifactDigest?: string;
}

/** Host callback for one capability-routed, non-recursive role assignment. @beta */
export type RoutedAgentExecutor = (
  routed: RoutedAssignment,
  context: ExecutionNodeExecutionContext
) => Promise<AgentResult>;

/** Contradictory claims requiring disclosure or independent verification. @beta */
export interface AgentResultConflict {
  readonly subject: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Requirement-coverage synthesis over structured expert results. @beta */
export interface AgentSynthesisResult {
  readonly coverage: number;
  readonly acceptedEvidenceIds: readonly string[];
  readonly missingCriteria: readonly string[];
  readonly conflicts: readonly AgentResultConflict[];
  readonly verifierAssignments: readonly AssignmentSpec[];
}
