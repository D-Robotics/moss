import { ErrorCode, MossError } from '../errors.js';
import type { CompletionReport } from './delivery-case.js';
import type { ExecutionGraphSnapshot, ExecutionStore } from './execution-types.js';

/** Measured values supplied by the host after one verified delivery run. @beta */
export interface CompletionReportMetrics {
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly wallTimeMs?: number;
  readonly humanInterventions: number;
}

/** Minimal human-authored input; traceable report sections are derived from graph evidence. @beta */
export interface GenerateCompletionReportInput {
  readonly summary: string;
  readonly knownLimitations?: readonly string[];
  readonly metrics: CompletionReportMetrics;
  readonly createdAt?: number;
}

/** Generates and atomically appends an evidence-derived completion report. @beta */
export class CompletionReportGenerator {
  constructor(private readonly store: ExecutionStore) {}

  generate(
    graphId: string,
    input: GenerateCompletionReportInput,
    expectedRevision?: number
  ): ExecutionGraphSnapshot {
    const graph = this.store.load(graphId);
    if (!graph) this.invalid(`unknown execution "${graphId}"`);
    const delivery = graph.deliveryCase;
    if (!delivery) this.invalid('completion report requires a delivery case');
    if (graph.verification?.verdict !== 'verified') {
      this.invalid('completion report requires a verified execution verdict');
    }
    const review = [...delivery.reviews].reverse().find((item) => item.scope === 'whole_change');
    if (!review || !['PASS', 'PASS_WITH_NOTES'].includes(review.verdict)) {
      this.invalid('completion report requires a passing whole-change review');
    }
    const requirementCoverage = delivery.requirements.map((requirement) => {
      const evidenceIds = new Set<string>();
      for (const artifact of delivery.artifacts) {
        if (artifact.requirementIds?.includes(requirement.id)) evidenceIds.add(artifact.evidenceId);
      }
      for (const evidence of graph.evidence) {
        if (evidence.metadata?.requirementId === requirement.id) evidenceIds.add(evidence.id);
      }
      for (const node of Object.values(graph.nodes)) {
        if (
          node.acceptanceContract?.criteria.some((criterion) =>
            criterion.requirementIds?.includes(requirement.id)
          )
        ) {
          node.evidenceIds.forEach((id) => evidenceIds.add(id));
        }
      }
      return {
        requirementId: requirement.id,
        covered: evidenceIds.size > 0,
        evidenceIds: [...evidenceIds],
      };
    });
    const uncovered = requirementCoverage.filter(
      (coverage) =>
        delivery.requirements.find((item) => item.id === coverage.requirementId)?.required &&
        !coverage.covered
    );
    if (uncovered.length > 0) {
      this.invalid(
        `completion report lacks evidence for requirements: ${uncovered.map((item) => item.requirementId).join(', ')}`
      );
    }
    const createdAt = input.createdAt ?? Date.now();
    const report: CompletionReport = {
      id: `report-${graph.id}-${graph.revision + 1}`,
      summary: this.required(input.summary, 'report summary'),
      requirementCoverage,
      decisions: delivery.decisions.map((decision) => decision.id),
      changedArtifacts: graph.evidence
        .filter((evidence) => evidence.kind === 'patch' || evidence.kind === 'artifact_digest')
        .map((evidence) => evidence.artifactRef ?? evidence.id),
      verificationEvidenceIds: graph.verification.evidenceIds,
      reviewIds: delivery.reviews.map((item) => item.id),
      knownLimitations: [...(input.knownLimitations ?? [])],
      followUps: [...new Set(delivery.reviews.flatMap((item) => item.notes))],
      metrics: input.metrics,
      createdAt,
    };
    return this.store.append(graph.id, {
      expectedRevision: expectedRevision ?? graph.revision,
      type: 'delivery.reported',
      time: createdAt,
      data: { report },
    });
  }

  private required(value: string, field: string): string {
    if (!value.trim()) this.invalid(`${field} must be non-empty`);
    return value.trim();
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.EXECUTION_STATE_INVALID, message });
  }
}
