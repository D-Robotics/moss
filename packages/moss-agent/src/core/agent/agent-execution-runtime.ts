import { randomUUID } from 'node:crypto';
import { ErrorCode, MossError } from '../../errors.js';
import { AssignmentRouter } from '../../orchestration/assignment-router.js';
import { synthesizeAgentResults } from '../../orchestration/agent-result-synthesis.js';
import type {
  AgentResult,
  AgentRoleRegistry,
  AgentSynthesisResult,
  AssignmentSpec,
  CompletionArbiter,
  CompletionDecision,
  CompletionTaskKind,
  ExecutionGraphScheduler,
  ExecutionEvidence,
  ExecutionNodeExecutor,
  ExecutionScheduleResult,
  ExecutionStore,
  WorkspaceLeaseAdapter,
  WorkspaceLease,
  RoutedAgentExecutor,
} from '../../orchestration/index.js';

/** Product result for one routed execution wave and its coverage synthesis. @beta */
export interface RoutedAgentExecutionOutcome {
  readonly schedule: ExecutionScheduleResult;
  readonly synthesis: AgentSynthesisResult;
  readonly completion?: CompletionDecision;
}

export function createAgentExecutionMethods(input: {
  scheduler: ExecutionGraphScheduler;
  arbiter: CompletionArbiter;
  workspaceLeases: WorkspaceLeaseAdapter;
  roles: AgentRoleRegistry;
  store: ExecutionStore;
  workspaceDir: string;
}) {
  return {
    runExecutionGraph: (
      graphId: string,
      executor: ExecutionNodeExecutor,
      taskKind: CompletionTaskKind = 'analysis'
    ) =>
      runAgentExecutionGraph({
        graphId,
        executor,
        taskKind,
        scheduler: input.scheduler,
        arbiter: input.arbiter,
        workspaceLeases: input.workspaceLeases,
      }),
    runRoutedExecutionGraph: (
      graphId: string,
      executor: RoutedAgentExecutor,
      taskKind: CompletionTaskKind = 'analysis',
      authorizeMerge?: (lease: WorkspaceLease, patchId: string) => void | Promise<void>
    ) =>
      runRoutedAgentExecutionGraph({
        graphId,
        executor,
        taskKind,
        scheduler: input.scheduler,
        arbiter: input.arbiter,
        workspaceLeases: input.workspaceLeases,
        roles: input.roles,
        store: input.store,
        workspaceDir: input.workspaceDir,
        ...(authorizeMerge ? { authorizeMerge } : {}),
      }),
  };
}

export async function runAgentExecutionGraph(input: {
  graphId: string;
  executor: ExecutionNodeExecutor;
  taskKind: CompletionTaskKind;
  scheduler: ExecutionGraphScheduler;
  arbiter: CompletionArbiter;
  workspaceLeases: WorkspaceLeaseAdapter;
}): Promise<{ schedule: ExecutionScheduleResult; completion?: CompletionDecision }> {
  const schedule = await input.scheduler.runAvailable(input.graphId, input.executor);
  if (
    !Object.values(schedule.graph.nodes).every(
      (node) => node.status === 'succeeded' || node.status === 'skipped'
    )
  ) {
    return { schedule };
  }
  const activeWorkspaceLeaseIds = input.workspaceLeases
    .list()
    .filter((lease) => lease.graphId === input.graphId && lease.status === 'active')
    .map((lease) => lease.id);
  const completion = await input.arbiter.decide(input.graphId, {
    taskKind: input.taskKind,
    activeWorkspaceLeaseIds,
  });
  return { schedule, completion };
}

function roleKind(kind: ExecutionScheduleResult['graph']['nodes'][string]['kind']) {
  if (kind === 'implementation' || kind === 'merge') return 'implementer' as const;
  if (kind === 'verification') return 'verifier' as const;
  return 'advisor' as const;
}

/** Route one graph wave through authorized role snapshots and synthesize structured gaps. */
export async function runRoutedAgentExecutionGraph(input: {
  graphId: string;
  executor: RoutedAgentExecutor;
  taskKind: CompletionTaskKind;
  scheduler: ExecutionGraphScheduler;
  arbiter: CompletionArbiter;
  workspaceLeases: WorkspaceLeaseAdapter;
  roles: AgentRoleRegistry;
  store: ExecutionStore;
  workspaceDir: string;
  authorizeMerge?: (lease: WorkspaceLease, patchId: string) => void | Promise<void>;
}): Promise<RoutedAgentExecutionOutcome> {
  const router = new AssignmentRouter(input.roles);
  const assignments: AssignmentSpec[] = [];
  const results: AgentResult[] = [];
  let schedule = await input.scheduler.runAvailable(input.graphId, async (node, graph, context) => {
    const assignment: AssignmentSpec = {
      id: `${graph.id}:${node.id}:${node.attempts + 1}`,
      graphId: graph.id,
      nodeId: node.id,
      goal: node.title,
      requiredRoleKind: roleKind(node.kind),
      requiredCapabilities: node.requiredCapabilities ?? [],
      inputEvidenceIds: node.dependencies.flatMap(
        (dependency) => graph.nodes[dependency]?.evidenceIds ?? []
      ),
      dependencies: node.dependencies,
      writePaths: node.writePaths ?? [],
      acceptanceCriteria: node.acceptanceCriteria ?? [],
      ...(node.budget ? { budget: node.budget } : {}),
    };
    if (assignment.requiredRoleKind === 'implementer' && assignment.writePaths.length === 0) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `implementation assignment "${assignment.id}" must declare write paths`,
      });
    }
    const workspaceLease =
      assignment.requiredRoleKind === 'implementer'
        ? await input.workspaceLeases.create({
            id: `assignment_${randomUUID()}`,
            graphId: graph.id,
            nodeId: node.id,
            parentWorkspace: input.workspaceDir,
            writePaths: assignment.writePaths,
          })
        : undefined;
    const selected = router.route(assignment);
    const routed = { ...selected, ...(workspaceLease ? { workspaceLease } : {}) };
    assignments.push(assignment);
    const result = await input.executor(routed, context);
    const knownEvidence = new Set([
      ...graph.evidence.map(({ id }) => id),
      ...result.claims.map(({ id }) => id),
    ]);
    let invalid =
      result.assignmentId !== assignment.id ||
      result.roleId !== routed.role.id ||
      result.evidenceRefs.some((id) => !knownEvidence.has(id));
    const evidence: ExecutionEvidence[] = result.claims.map((claim) => ({
      id: claim.id,
      kind: 'expert_claim' as const,
      nodeId: node.id,
      summary: `${claim.subject}: ${claim.conclusion}`,
      createdAt: Date.now(),
      metadata: {
        roleId: routed.role.id,
        roleKind: routed.role.kind,
        runId: result.runId ?? assignment.id,
        severity: claim.severity,
        evidenceRefs: claim.evidenceRefs.join(','),
      },
    }));
    if (routed.role.kind === 'implementer' && result.status === 'PASS') {
      if (!workspaceLease || !result.patchRef || !input.authorizeMerge) {
        invalid = true;
      } else {
        await input.authorizeMerge(workspaceLease, result.patchRef);
        const merge = await input.workspaceLeases.mergeStored(workspaceLease.id, result.patchRef);
        if (merge.status !== 'merged') {
          invalid = true;
        } else {
          evidence.push({
            id: `merged-${result.patchRef}`,
            kind: 'patch',
            nodeId: node.id,
            summary: `Merged routed implementation patch ${result.patchRef}`,
            createdAt: Date.now(),
            metadata: {
              merged: true,
              patchId: result.patchRef,
              runId: result.runId ?? assignment.id,
            },
          });
        }
      }
    }
    if (routed.role.kind === 'verifier' && result.status === 'PASS') {
      if (!result.verification || result.verification.exitCode !== 0) {
        invalid = true;
      } else {
        evidence.push({
          id: `verification-${assignment.id}`,
          kind: 'verification',
          nodeId: node.id,
          summary: result.verification.summary,
          createdAt: Date.now(),
          ...(result.verification.artifactDigest
            ? { digest: result.verification.artifactDigest }
            : {}),
          metadata: {
            command: result.verification.command,
            exitCode: result.verification.exitCode,
            fresh: true,
            independent: true,
            roleKind: 'verifier',
            roleId: routed.role.id,
            runId: result.runId ?? assignment.id,
          },
        });
      }
    }
    for (const [index, criterion] of assignment.acceptanceCriteria.entries()) {
      if (result.unmetCriteria.includes(criterion)) continue;
      evidence.push({
        id: `criterion-${assignment.id}-${index}`,
        kind: 'expert_claim',
        nodeId: node.id,
        summary: `Acceptance criterion satisfied: ${criterion}`,
        createdAt: Date.now(),
        metadata: { criterion, roleId: routed.role.id, runId: result.runId ?? assignment.id },
      });
    }
    results.push(invalid ? { ...result, status: 'FAIL' } : result);
    const structuredOutput =
      routed.role.kind === 'implementer'
        ? evidence.some(({ kind }) => kind === 'patch')
        : routed.role.kind === 'verifier'
          ? evidence.some(({ kind }) => kind === 'verification')
          : result.claims.length > 0 || result.evidenceRefs.length > 0;
    const success =
      !invalid && result.status === 'PASS' && result.unmetCriteria.length === 0 && structuredOutput;
    return {
      success,
      evidence,
      ...(!success
        ? {
            error: invalid
              ? 'Agent result, patch merge, or verifier receipt violated its routed contract'
              : `Agent result was ${result.status} with unmet criteria`,
            failureFingerprint: `agent-result:${invalid ? 'invalid' : result.status}`,
          }
        : {}),
    };
  });
  const synthesis = synthesizeAgentResults({ assignments, results });
  let graph = input.store.load(input.graphId) ?? schedule.graph;
  for (const verifier of synthesis.verifierAssignments) {
    if (graph.nodes[verifier.nodeId]) continue;
    graph = input.store.append(graph.id, {
      expectedRevision: graph.revision,
      type: 'node.added',
      data: {
        node: {
          id: verifier.nodeId,
          kind: 'verification',
          title: verifier.goal,
          dependencies: verifier.dependencies,
          requiredCapabilities: verifier.requiredCapabilities,
          acceptanceCriteria: verifier.acceptanceCriteria,
        },
      },
    });
  }
  schedule = { ...schedule, graph };
  if (
    synthesis.missingCriteria.length > 0 ||
    !Object.values(graph.nodes).every(
      (node) => node.status === 'succeeded' || node.status === 'skipped'
    )
  ) {
    return { schedule, synthesis };
  }
  const activeWorkspaceLeaseIds = input.workspaceLeases
    .list()
    .filter((lease) => lease.graphId === input.graphId && lease.status === 'active')
    .map((lease) => lease.id);
  const completion = await input.arbiter.decide(input.graphId, {
    taskKind: input.taskKind,
    activeWorkspaceLeaseIds,
  });
  return {
    schedule: { ...schedule, graph: input.store.load(input.graphId) ?? graph },
    synthesis,
    completion,
  };
}

export function createWorkspacePatchMerger(
  workspaceLeases: WorkspaceLeaseAdapter,
  executionStore: ExecutionStore
) {
  return async (leaseId: string, patchId: string) => {
    const lease = workspaceLeases.load(leaseId);
    if (!lease) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `unknown workspace lease "${leaseId}"`,
      });
    }
    const result = await workspaceLeases.mergeStored(leaseId, patchId);
    const graph = executionStore.load(lease.graphId);
    if (result.status === 'merged' && graph?.nodes[lease.nodeId]) {
      const node = graph.nodes[lease.nodeId];
      executionStore.append(graph.id, {
        expectedRevision: graph.revision,
        type: 'evidence.recorded',
        nodeId: lease.nodeId,
        data: {
          evidence: {
            id: `merged-${patchId}`,
            kind: 'patch',
            nodeId: lease.nodeId,
            summary: `Merged isolated workspace patch ${patchId}`,
            createdAt: Date.now(),
            digest: result.digest,
            metadata: {
              merged: true,
              patchId,
              runId: lease.nodeId,
              ...(node.acceptanceCriteria?.includes('patch-merged')
                ? { criterion: 'patch-merged' }
                : {}),
            },
          },
        },
      });
    }
    return result;
  };
}
