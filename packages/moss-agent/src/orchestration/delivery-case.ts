import { ErrorCode, MossError } from '../errors.js';

/** Delivery rigor selected from risk and scope. @beta */
export type DeliveryDepth = 'minimal' | 'standard' | 'comprehensive';

/** Human-visible lifecycle for one durable delivery case. @beta */
export type DeliveryStage =
  | 'intake'
  | 'elaborating'
  | 'proposed'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled';

/** Risk floor used to prevent a model or plugin from lowering delivery rigor. @beta */
export type DeliveryRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** One traceable requirement owned by a delivery case. @beta */
export interface DeliveryRequirement {
  readonly id: string;
  readonly statement: string;
  readonly required: boolean;
}

/** One structured clarification question and its validated answer. @beta */
export interface ElaborationQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly answer?: string;
  readonly status: 'unanswered' | 'answered' | 'conflicted';
}

/** One immutable clarification round. @beta */
export interface ElaborationRound {
  readonly id: string;
  readonly index: number;
  readonly questions: readonly ElaborationQuestion[];
  readonly resolved: boolean;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

/** Revisioned proposal that maps requirements to execution nodes. @beta */
export interface DeliveryProposal {
  readonly revision: number;
  readonly summary: string;
  readonly requirementIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly requiresApproval: boolean;
  readonly evidenceIds: readonly string[];
  readonly approvedAt?: number;
  readonly approvalEvidenceId?: string;
}

/** Decision retained with rationale for completion reporting. @beta */
export interface DeliveryDecision {
  readonly id: string;
  readonly summary: string;
  readonly rationale: string;
  readonly createdAt: number;
}

/** Immutable reference to a delivery artifact stored as execution evidence. @beta */
export interface DeliveryArtifact {
  readonly id: string;
  readonly kind:
    | 'requirement'
    | 'decision'
    | 'proposal'
    | 'design'
    | 'reference'
    | 'patch'
    | 'verification'
    | 'report';
  readonly evidenceId: string;
  readonly digest?: string;
  readonly requirementIds?: readonly string[];
}

/** Scope reviewed by an independent read-only delivery role. @beta */
export type DeliveryReviewScope = 'proposal' | 'node' | 'whole_change';

/** Structured review outcome consumed by the completion arbiter. @beta */
export type DeliveryReviewVerdict = 'PASS' | 'PASS_WITH_NOTES' | 'FAIL' | 'PARTIAL';

/** One immutable reviewer round. @beta */
export interface DeliveryReview {
  readonly id: string;
  readonly scope: DeliveryReviewScope;
  readonly round: number;
  readonly verdict: DeliveryReviewVerdict;
  readonly roleId: string;
  readonly independent: boolean;
  readonly readOnly: boolean;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly reviewedAt: number;
}

/** Requirement-level coverage retained in the final report. @beta */
export interface DeliveryRequirementCoverage {
  readonly requirementId: string;
  readonly covered: boolean;
  readonly evidenceIds: readonly string[];
}

/** Human-readable report generated only from accepted structured evidence. @beta */
export interface CompletionReport {
  readonly id: string;
  readonly summary: string;
  readonly requirementCoverage: readonly DeliveryRequirementCoverage[];
  readonly decisions: readonly string[];
  readonly changedArtifacts: readonly string[];
  readonly verificationEvidenceIds: readonly string[];
  readonly reviewIds: readonly string[];
  readonly knownLimitations: readonly string[];
  readonly followUps: readonly string[];
  readonly metrics: {
    readonly tokens?: number;
    readonly costUsd?: number;
    readonly wallTimeMs?: number;
    readonly humanInterventions: number;
  };
  readonly createdAt: number;
}

/** Seed persisted inside graph.created for a delivery case. @beta */
export interface CreateDeliveryCaseInput {
  readonly depth: DeliveryDepth;
  readonly riskLevel: DeliveryRiskLevel;
  readonly requirements: readonly DeliveryRequirement[];
}

/** Current durable delivery projection embedded in an execution graph. @beta */
export interface DeliveryCaseSnapshot {
  readonly graphId: string;
  readonly depth: DeliveryDepth;
  readonly riskLevel: DeliveryRiskLevel;
  readonly stage: DeliveryStage;
  readonly requirements: readonly DeliveryRequirement[];
  readonly elaborationRounds: readonly ElaborationRound[];
  readonly decisions: readonly DeliveryDecision[];
  readonly artifacts: readonly DeliveryArtifact[];
  readonly proposal?: DeliveryProposal;
  readonly reviews: readonly DeliveryReview[];
  readonly completionReport?: CompletionReport;
}

interface DeliveryEventLike {
  readonly type: string;
  readonly time: number;
  readonly data: Readonly<Record<string, unknown>>;
}

const STAGE_TRANSITIONS: Readonly<Record<DeliveryStage, readonly DeliveryStage[]>> = {
  intake: ['elaborating', 'proposed', 'blocked', 'cancelled'],
  elaborating: ['elaborating', 'proposed', 'blocked', 'cancelled'],
  proposed: ['proposed', 'executing', 'blocked', 'cancelled'],
  executing: ['verifying', 'blocked', 'cancelled'],
  verifying: ['executing', 'blocked', 'cancelled'],
  completed: [],
  blocked: ['elaborating', 'proposed', 'executing', 'verifying', 'cancelled'],
  cancelled: [],
};

function invalid(message: string): MossError {
  return new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be non-empty`);
  return value.trim();
}

function normalizeRequirement(requirement: DeliveryRequirement): DeliveryRequirement {
  return {
    id: requiredString(requirement.id, 'requirement.id'),
    statement: requiredString(requirement.statement, 'requirement.statement'),
    required: requirement.required !== false,
  };
}

/** Create the initial delivery projection for graph.created. @beta */
export function createDeliveryCaseSnapshot(
  graphId: string,
  input: CreateDeliveryCaseInput
): DeliveryCaseSnapshot {
  if (!['minimal', 'standard', 'comprehensive'].includes(input.depth)) {
    throw invalid('delivery depth is invalid');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(input.riskLevel)) {
    throw invalid('delivery risk level is invalid');
  }
  const requirements = input.requirements.map(normalizeRequirement);
  const depthOrder: readonly DeliveryDepth[] = ['minimal', 'standard', 'comprehensive'];
  const minimumDepth: DeliveryDepth =
    input.riskLevel === 'high' || input.riskLevel === 'critical'
      ? 'comprehensive'
      : input.riskLevel === 'medium'
        ? 'standard'
        : 'minimal';
  const depth =
    depthOrder.indexOf(input.depth) >= depthOrder.indexOf(minimumDepth)
      ? input.depth
      : minimumDepth;
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (ids.has(requirement.id)) throw invalid(`duplicate requirement "${requirement.id}"`);
    ids.add(requirement.id);
  }
  return {
    graphId,
    depth,
    riskLevel: input.riskLevel,
    stage: 'intake',
    requirements,
    elaborationRounds: [],
    decisions: [],
    artifacts: [],
    reviews: [],
  };
}

function normalizeRound(raw: ElaborationRound, expectedIndex: number): ElaborationRound {
  if (raw.index !== expectedIndex)
    throw invalid(`elaboration round index must be ${expectedIndex}`);
  if (raw.questions.length === 0) throw invalid('elaboration round requires at least one question');
  const questions = raw.questions.map((question) => ({
    id: requiredString(question.id, 'elaboration question id'),
    prompt: requiredString(question.prompt, 'elaboration question prompt'),
    options: question.options.map((option) => requiredString(option, 'elaboration option')),
    ...(question.answer ? { answer: question.answer.trim() } : {}),
    status: question.status,
  }));
  if (raw.resolved && questions.some((question) => question.status !== 'answered')) {
    throw invalid('resolved elaboration round contains unanswered or conflicting questions');
  }
  return { ...raw, questions };
}

function normalizeProposal(
  deliveryCase: DeliveryCaseSnapshot,
  raw: DeliveryProposal
): DeliveryProposal {
  if (
    deliveryCase.depth !== 'minimal' &&
    !deliveryCase.elaborationRounds.some((round) => round.resolved)
  ) {
    throw invalid(`${deliveryCase.depth} delivery requires a resolved elaboration round`);
  }
  const expectedRevision = (deliveryCase.proposal?.revision ?? 0) + 1;
  if (raw.revision !== expectedRevision) {
    throw invalid(`proposal revision must advance to ${expectedRevision}`);
  }
  const requirementIds = new Set(deliveryCase.requirements.map((item) => item.id));
  for (const id of raw.requirementIds) {
    if (!requirementIds.has(id)) throw invalid(`proposal references unknown requirement "${id}"`);
  }
  const proposedRequirements = new Set(raw.requirementIds);
  const omittedRequired = deliveryCase.requirements.filter(
    (requirement) => requirement.required && !proposedRequirements.has(requirement.id)
  );
  if (omittedRequired.length > 0) {
    throw invalid(
      `proposal omits required requirements: ${omittedRequired.map(({ id }) => id).join(', ')}`
    );
  }
  return {
    ...raw,
    summary: requiredString(raw.summary, 'proposal summary'),
    requirementIds: [...new Set(raw.requirementIds)],
    nodeIds: [...new Set(raw.nodeIds)],
    evidenceIds: [...new Set(raw.evidenceIds)],
    requiresApproval: deliveryCase.depth === 'comprehensive' || raw.requiresApproval,
    approvedAt: undefined,
    approvalEvidenceId: undefined,
  };
}

function changeStage(
  deliveryCase: DeliveryCaseSnapshot,
  stage: DeliveryStage
): DeliveryCaseSnapshot {
  if (!STAGE_TRANSITIONS[deliveryCase.stage].includes(stage)) {
    throw invalid(`delivery case cannot transition from ${deliveryCase.stage} to ${stage}`);
  }
  if (
    stage === 'executing' &&
    deliveryCase.proposal?.requiresApproval &&
    !deliveryCase.proposal.approvedAt
  ) {
    throw invalid('delivery case requires proposal approval before execution');
  }
  return { ...deliveryCase, stage };
}

/** Apply one validated delivery event to the current projection. @beta */
export function applyDeliveryCaseEvent(
  deliveryCase: DeliveryCaseSnapshot,
  event: DeliveryEventLike
): DeliveryCaseSnapshot {
  if (event.type === 'delivery.elaboration_recorded') {
    const raw = event.data.round;
    if (!raw || typeof raw !== 'object') throw invalid('delivery elaboration requires round');
    if (deliveryCase.elaborationRounds.length >= 3) {
      throw invalid('delivery elaboration exceeded the three-round limit');
    }
    const round = normalizeRound(
      raw as ElaborationRound,
      deliveryCase.elaborationRounds.length + 1
    );
    const next =
      deliveryCase.stage === 'intake' ? changeStage(deliveryCase, 'elaborating') : deliveryCase;
    return { ...next, elaborationRounds: [...next.elaborationRounds, round] };
  }
  if (event.type === 'delivery.proposal_recorded') {
    const raw = event.data.proposal;
    if (!raw || typeof raw !== 'object') throw invalid('delivery proposal requires proposal');
    const proposal = normalizeProposal(deliveryCase, raw as DeliveryProposal);
    const next =
      deliveryCase.stage === 'proposed' ? deliveryCase : changeStage(deliveryCase, 'proposed');
    return { ...next, proposal };
  }
  if (event.type === 'delivery.proposal_approved') {
    if (!deliveryCase.proposal) throw invalid('delivery case has no proposal to approve');
    const approvedAt = Number(event.data.approvedAt ?? event.time);
    const evidenceId = requiredString(event.data.evidenceId, 'proposal approval evidenceId');
    return {
      ...deliveryCase,
      proposal: {
        ...deliveryCase.proposal,
        approvedAt,
        approvalEvidenceId: evidenceId,
      },
    };
  }
  if (event.type === 'delivery.stage_changed') {
    return changeStage(deliveryCase, event.data.stage as DeliveryStage);
  }
  if (event.type === 'delivery.review_recorded') {
    if (deliveryCase.stage !== 'verifying') {
      throw invalid('delivery review requires the verifying stage');
    }
    const raw = event.data.review;
    if (!raw || typeof raw !== 'object') throw invalid('delivery review requires review');
    const review = raw as DeliveryReview;
    if (!review.independent || !review.readOnly) {
      throw invalid('delivery reviewer must be independent and read-only');
    }
    const expectedRound =
      deliveryCase.reviews.filter((item) => item.scope === review.scope).length + 1;
    if (review.round !== expectedRound || review.round > 3) {
      throw invalid(`delivery review round must be ${expectedRound} and no greater than 3`);
    }
    if (review.verdict === 'FAIL' && review.blockers.length === 0) {
      throw invalid('failed delivery review requires at least one blocker');
    }
    if (
      (review.verdict === 'PASS' || review.verdict === 'PASS_WITH_NOTES') &&
      review.blockers.length > 0
    ) {
      throw invalid('passing delivery review cannot retain blockers');
    }
    return {
      ...deliveryCase,
      ...((review.verdict === 'FAIL' || review.verdict === 'PARTIAL') && review.round === 3
        ? { stage: 'blocked' as const }
        : {}),
      reviews: [
        ...deliveryCase.reviews,
        {
          ...review,
          id: requiredString(review.id, 'review.id'),
          roleId: requiredString(review.roleId, 'review.roleId'),
          blockers: review.blockers.map((item) => requiredString(item, 'review blocker')),
          notes: review.notes.map((item) => requiredString(item, 'review note')),
          evidenceIds: [...new Set(review.evidenceIds)],
        },
      ],
    };
  }
  if (event.type === 'delivery.reported') {
    const latestReview = [...deliveryCase.reviews]
      .reverse()
      .find((review) => review.scope === 'whole_change');
    if (!latestReview || !['PASS', 'PASS_WITH_NOTES'].includes(latestReview.verdict)) {
      throw invalid('completion report requires a passing whole-change review');
    }
    const raw = event.data.report;
    if (!raw || typeof raw !== 'object') throw invalid('delivery report requires report');
    const report = raw as CompletionReport;
    return {
      ...deliveryCase,
      stage: 'completed',
      completionReport: {
        ...report,
        id: requiredString(report.id, 'report.id'),
        summary: requiredString(report.summary, 'report.summary'),
      },
    };
  }
  return deliveryCase;
}
