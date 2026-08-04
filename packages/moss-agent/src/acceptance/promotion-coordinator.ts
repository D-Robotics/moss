import { errorMessage } from '../errors.js';
import { getRootLogger } from '../logger.js';
import type { ObservationStats } from '../memory/observation-aggregator.js';
import {
  evaluatePromotion,
  type PromotionDecision,
  type PromotionGateThresholds,
} from './promotion-gate.js';

const log = getRootLogger().child('acceptance:promotion');

export interface PromotionCandidateProvenance {
  layer: 'L2';
  kind: 'explicit-proposal';
  source: string;
  proposalRef: string;
}

export interface PromotionCandidate {
  id: string;
  targetSkill: string;
  provenance: PromotionCandidateProvenance;
}

export type PromotionCandidateSource<TCompletion> = (
  completion: TCompletion,
) => readonly PromotionCandidate[] | Promise<readonly PromotionCandidate[]>;

export type PromotionStatsSource = (
  candidate: PromotionCandidate,
) => ObservationStats | undefined | Promise<ObservationStats | undefined>;

export type CandidateCrossSignalVerifier = (
  candidate: PromotionCandidate,
) => boolean | Promise<boolean>;

export interface PromotionDecisionRecord {
  candidate: PromotionCandidate;
  decision: PromotionDecision;
}

export type PromotionDecisionSink = (
  record: PromotionDecisionRecord,
) => void | Promise<void>;

export interface PromotionCoordinatorDeps<TCompletion> {
  candidateSource: PromotionCandidateSource<TCompletion>;
  statsSource: PromotionStatsSource;
  crossSignalVerifier: CandidateCrossSignalVerifier;
  decisionSink: PromotionDecisionSink;
}

export interface PromotionCoordinatorOptions {
  thresholds?: PromotionGateThresholds;
}

export class PromotionCoordinator<TCompletion> {
  constructor(
    private readonly deps: PromotionCoordinatorDeps<TCompletion>,
    private readonly options: PromotionCoordinatorOptions = {},
  ) {}

  async observeCompletion(completion: TCompletion): Promise<void> {
    let candidates: readonly PromotionCandidate[];
    try {
      candidates = await this.deps.candidateSource(completion);
    } catch (error) {
      log.warn('promotion candidate discovery failed', { error: errorMessage(error) });
      return;
    }

    for (const candidate of candidates) {
      let stats: ObservationStats | undefined;
      try {
        stats = await this.deps.statsSource(candidate);
      } catch (error) {
        log.warn('promotion statistics lookup failed', {
          candidateId: candidate.id,
          error: errorMessage(error),
        });
        continue;
      }
      if (!stats) continue;

      let decision: PromotionDecision;
      try {
        decision = await evaluatePromotion(
          stats,
          () => this.deps.crossSignalVerifier(candidate),
          this.options.thresholds,
        );
      } catch (error) {
        log.warn('promotion candidate evaluation failed', {
          candidateId: candidate.id,
          error: errorMessage(error),
        });
        continue;
      }

      try {
        await this.deps.decisionSink({ candidate, decision });
      } catch (error) {
        log.warn('promotion decision delivery failed', {
          candidateId: candidate.id,
          error: errorMessage(error),
        });
      }
    }
  }
}
