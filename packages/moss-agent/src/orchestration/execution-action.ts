import { ErrorCode, MossError } from '../errors.js';
import type { AcceptanceContract } from './acceptance-contract.js';
import type {
  DeliveryProposal,
  DeliveryReview,
  DeliveryStage,
  ElaborationRound,
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
  | { readonly type: 'record_proposal'; readonly proposal: DeliveryProposal }
  | { readonly type: 'approve_proposal'; readonly evidenceId: string }
  | { readonly type: 'transition_delivery'; readonly stage: DeliveryStage }
  | {
      readonly type: 'revise_acceptance';
      readonly nodeId: string;
      readonly contract: AcceptanceContract;
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
    if (action.type === 'record_review') {
      return this.append(graphId, expectedRevision, 'delivery.review_recorded', {
        review: action.review,
        fixNodes: action.fixNodes ?? [],
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
      | 'delivery.proposal_recorded'
      | 'delivery.proposal_approved'
      | 'delivery.stage_changed'
      | 'delivery.review_recorded'
      | 'graph.blocked',
    data: Readonly<Record<string, unknown>>
  ): ExecutionGraphSnapshot {
    return this.store.append(graphId, { expectedRevision, type, data });
  }

  private required(value: string, field: string): string {
    if (!value.trim()) this.invalid(`${field} must be non-empty`);
    return value.trim();
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }
}
