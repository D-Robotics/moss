import { ErrorCode, MossError } from '../errors.js';
import type { AcceptanceContract, AcceptanceVerdict } from './acceptance-contract.js';
import type {
  DeliveryProposal,
  DeliveryReview,
  DeliveryStage,
  ElaborationRound,
  DeliveryRequirement,
  DeliveryDecision,
  DeliveryArtifact,
} from './delivery-case.js';
import {
  CompletionReportGenerator,
  type GenerateCompletionReportInput,
} from './completion-report-generator.js';
import { ExecutionTaskController } from './execution-task-controller.js';
import type {
  ExecutionGraphSnapshot,
  ExecutionNodeDefinition,
  ExecutionStore,
} from './execution-types.js';

/** User and host actions accepted by the shared execution control plane. @beta */
export type ExecutionAction =
  | { readonly type: 'resume' }
  | { readonly type: 'retry'; readonly nodeId: string }
  | { readonly type: 'stop' }
  | { readonly type: 'record_elaboration'; readonly round: ElaborationRound }
  | {
      readonly type: 'answer_elaboration';
      readonly roundId: string;
      readonly answers: Readonly<Record<string, string | readonly string[]>>;
      readonly conflictQuestionIds?: readonly string[];
    }
  | { readonly type: 'prepare_proposal'; readonly summary?: string }
  | {
      readonly type: 'revise_requirements';
      readonly requirements: readonly DeliveryRequirement[];
      readonly reason: string;
    }
  | { readonly type: 'record_decision'; readonly decision: DeliveryDecision }
  | { readonly type: 'record_artifact'; readonly artifact: DeliveryArtifact }
  | { readonly type: 'record_proposal'; readonly proposal: DeliveryProposal }
  | { readonly type: 'approve_proposal'; readonly evidenceId: string }
  | { readonly type: 'transition_delivery'; readonly stage: DeliveryStage }
  | {
      readonly type: 'revise_acceptance';
      readonly nodeId: string;
      readonly contract: AcceptanceContract;
    }
  | {
      readonly type: 'record_acceptance_verdict';
      readonly nodeId: string;
      readonly verdict: AcceptanceVerdict;
    }
  | {
      readonly type: 'record_review';
      readonly review: DeliveryReview;
      readonly fixNodes?: readonly ExecutionNodeDefinition[];
    }
  | { readonly type: 'publish_report'; readonly input: GenerateCompletionReportInput }
  | { readonly type: 'request_manual_review'; readonly reason: string };

/** Store-backed mutation seam shared by Web, CLI, TUI, ACP, and plugins. @beta */
export class StoreExecutionActionController {
  private readonly tasks: ExecutionTaskController;
  private readonly reports: CompletionReportGenerator;

  constructor(private readonly store: ExecutionStore) {
    this.tasks = new ExecutionTaskController(store);
    this.reports = new CompletionReportGenerator(store);
  }

  execute(
    graphId: string,
    expectedRevision: number,
    action: ExecutionAction
  ): ExecutionGraphSnapshot {
    const graph = this.store.load(graphId);
    if (!graph) this.invalid(`unknown execution "${graphId}"`);
    if (graph.revision !== expectedRevision) {
      throw new MossError({
        code: ErrorCode.EXECUTION_REVISION_CONFLICT,
        message: `execution graph "${graphId}" revision is ${graph.revision}, expected ${expectedRevision}`,
        recoverable: true,
      });
    }
    if (action.type === 'resume') return this.tasks.resume(graphId);
    if (action.type === 'retry') return this.tasks.retry(graphId, action.nodeId);
    if (action.type === 'stop') return this.tasks.stop(graphId);
    if (action.type === 'record_elaboration') {
      return this.append(graphId, expectedRevision, 'delivery.elaboration_recorded', {
        round: action.round,
      });
    }
    if (action.type === 'answer_elaboration') {
      return this.append(graphId, expectedRevision, 'delivery.elaboration_answered', {
        roundId: this.required(action.roundId, 'elaboration round id'),
        answers: action.answers,
        conflictQuestionIds: action.conflictQuestionIds ?? [],
      });
    }
    if (action.type === 'prepare_proposal') {
      return this.prepareProposal(graphId, expectedRevision, action.summary);
    }
    if (action.type === 'revise_requirements') {
      return this.append(graphId, expectedRevision, 'delivery.requirements_revised', {
        requirements: action.requirements,
        reason: this.required(action.reason, 'requirement revision reason'),
      });
    }
    if (action.type === 'record_decision') {
      return this.append(graphId, expectedRevision, 'delivery.decision_recorded', {
        decision: action.decision,
      });
    }
    if (action.type === 'record_artifact') {
      return this.append(graphId, expectedRevision, 'delivery.artifact_recorded', {
        artifact: action.artifact,
      });
    }
    if (action.type === 'record_proposal') {
      return this.append(graphId, expectedRevision, 'delivery.proposal_recorded', {
        proposal: action.proposal,
      });
    }
    if (action.type === 'approve_proposal') {
      return this.append(graphId, expectedRevision, 'delivery.proposal_approved', {
        evidenceId: action.evidenceId,
      });
    }
    if (action.type === 'transition_delivery') {
      return this.append(graphId, expectedRevision, 'delivery.stage_changed', {
        stage: action.stage,
      });
    }
    if (action.type === 'revise_acceptance') {
      return this.store.append(graphId, {
        expectedRevision,
        type: 'acceptance.revised',
        nodeId: action.nodeId,
        data: { contract: action.contract },
      });
    }
    if (action.type === 'record_acceptance_verdict') {
      return this.store.append(graphId, {
        expectedRevision,
        type: 'acceptance.verdict_recorded',
        nodeId: action.nodeId,
        data: { verdict: action.verdict },
      });
    }
    if (action.type === 'record_review') {
      const fixNodes =
        action.fixNodes?.length ||
        !['FAIL', 'PARTIAL'].includes(action.review.verdict) ||
        action.review.round >= 3
          ? (action.fixNodes ?? [])
          : this.reviewFixNodes(graph, action.review);
      return this.append(graphId, expectedRevision, 'delivery.review_recorded', {
        review: action.review,
        fixNodes,
      });
    }
    if (action.type === 'publish_report') {
      return this.reports.generate(graphId, action.input, expectedRevision);
    }
    return this.append(graphId, expectedRevision, 'graph.blocked', {
      reason: this.required(action.reason, 'manual review reason'),
      requestedBy: 'user',
    });
  }

  private append(
    graphId: string,
    expectedRevision: number,
    type:
      | 'delivery.elaboration_recorded'
      | 'delivery.elaboration_answered'
      | 'delivery.requirements_revised'
      | 'delivery.decision_recorded'
      | 'delivery.artifact_recorded'
      | 'delivery.proposal_recorded'
      | 'delivery.proposal_approved'
      | 'delivery.stage_changed'
      | 'delivery.review_recorded'
      | 'graph.blocked',
    data: Readonly<Record<string, unknown>>
  ): ExecutionGraphSnapshot {
    return this.store.append(graphId, { expectedRevision, type, data });
  }

  private prepareProposal(
    graphId: string,
    expectedRevision: number,
    summary?: string
  ): ExecutionGraphSnapshot {
    let graph = this.store.load(graphId);
    if (!graph?.deliveryCase) this.invalid('proposal preparation requires a delivery case');
    if (
      graph.deliveryCase.depth !== 'minimal' &&
      !graph.deliveryCase.elaborationRounds.some((round) => round.resolved)
    ) {
      this.invalid('proposal preparation requires resolved elaboration');
    }
    graph = this.store.append(graphId, {
      expectedRevision,
      type: 'delivery.proposal_recorded',
      data: {
        proposal: {
          revision: (graph.deliveryCase.proposal?.revision ?? 0) + 1,
          summary: summary?.trim() || `Deliver and verify: ${graph.goal}`,
          requirementIds: graph.deliveryCase.requirements.map((requirement) => requirement.id),
          nodeIds: Object.keys(graph.nodes),
          requiresApproval: graph.deliveryCase.depth !== 'minimal',
          evidenceIds: [],
          nonGoals: [],
          risks:
            graph.deliveryCase.riskLevel === 'low'
              ? []
              : [`${graph.deliveryCase.riskLevel} delivery risk must be reviewed`],
          permissions: Object.values(graph.nodes).some((node) => node.kind === 'implementation')
            ? ['Approve isolated workspace merge before parent mutation']
            : [],
          nodePlans: Object.values(graph.nodes).map((node) => ({
            nodeId: node.id,
            ...(node.roleId ? { roleId: node.roleId } : {}),
            writePaths: node.writePaths ?? [],
            ...(node.acceptanceContract
              ? { acceptanceRevision: node.acceptanceContract.revision }
              : {}),
          })),
          workspaceStrategy: Object.values(graph.nodes).some(
            (node) => node.kind === 'implementation'
          )
            ? 'isolated-write'
            : 'shared-readonly',
          budget: Object.fromEntries(
            Object.entries(graph.budget).filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number'
            )
          ),
        },
      },
    });
    const proposal = graph.deliveryCase?.proposal;
    if (!proposal) this.invalid('proposal preparation did not persist a proposal');
    const evidenceId = `proposal-review-${graph.id}-${proposal.revision}`;
    graph = this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'evidence.recorded',
      data: {
        evidence: {
          id: evidenceId,
          kind: 'verification',
          summary: 'Built-in proposal reviewer verified requirement and node coverage',
          createdAt: Date.now(),
          metadata: {
            scope: 'proposal',
            independent: true,
            readOnly: true,
            proposalRevision: proposal.revision,
          },
        },
      },
    });
    graph = this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'delivery.review_recorded',
      data: {
        review: {
          id: `proposal-review-${graph.id}-${proposal.revision}`,
          scope: 'proposal',
          round:
            (graph.deliveryCase?.reviews.filter((review) => review.scope === 'proposal').length ??
              0) + 1,
          verdict: 'PASS',
          roleId: 'builtin:proposal-reviewer',
          independent: true,
          readOnly: true,
          blockers: [],
          notes: [],
          evidenceIds: [evidenceId],
          reviewedAt: Date.now(),
        },
        fixNodes: [],
      },
    });
    return this.store.append(graphId, {
      expectedRevision: graph.revision,
      type: 'delivery.artifact_recorded',
      data: {
        artifact: {
          id: `proposal-${graph.id}-${proposal.revision}`,
          kind: 'proposal',
          evidenceId,
          requirementIds: proposal.requirementIds,
        },
      },
    });
  }

  private reviewFixNodes(
    graph: ExecutionGraphSnapshot,
    review: DeliveryReview
  ): readonly ExecutionNodeDefinition[] {
    const writePaths = [
      ...new Set(
        Object.values(graph.nodes).flatMap((node) =>
          node.kind === 'implementation' ? (node.writePaths ?? []) : []
        )
      ),
    ];
    const mutating = writePaths.length > 0;
    const blockers =
      review.blockers.length > 0 ? review.blockers : ['Resolve partial review coverage'];
    return blockers.map((blocker, index) => ({
      id: `review-fix-${review.scope}-${review.round}-${index + 1}`,
      kind: mutating ? ('implementation' as const) : ('analysis' as const),
      title: `Resolve review blocker: ${blocker}`,
      dependencies: [],
      roleId: 'builtin:review-fixer',
      ...(mutating
        ? {
            writePaths,
            acceptanceContract: {
              revision: 1,
              criteria: [
                {
                  id: `review-blocker-${review.round}-${index + 1}`,
                  description: blocker,
                  kind: 'semantic' as const,
                  required: true,
                },
              ],
              verificationPolicy: 'all_required' as const,
            },
          }
        : {}),
    }));
  }

  private required(value: string, field: string): string {
    if (!value.trim()) this.invalid(`${field} must be non-empty`);
    return value.trim();
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }
}
