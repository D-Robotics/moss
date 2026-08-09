import type { SkillPlan } from './composer-types.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

export interface SkillCompositionTrace {
  provider: SkillPlan['provider'];
  registryDigest?: string;
  candidateScores: Array<{ stableId: string; name: string; score: number; reasonCodes: string[] }>;
  finalOrder: string[];
  finalNames: string[];
  cardinality: number;
  rejected: boolean;
  fallbackReason?: string;
  rejectionReason?: string;
  latencyMs?: number;
  injectedChars?: number;
}

export function toSkillCompositionTrace(plan: SkillPlan): SkillCompositionTrace {
  return {
    provider: plan.provider,
    ...(plan.diagnostics?.registryDigest
      ? { registryDigest: plan.diagnostics.registryDigest }
      : {}),
    candidateScores: (plan.diagnostics?.candidateScores ?? []).slice(0, 64).map((candidate) => ({
      stableId: candidate.stableId,
      name: candidate.name,
      score: candidate.score,
      reasonCodes: [...candidate.reasonCodes],
    })),
    finalOrder: plan.skills.map((skill) => skill.stableId),
    finalNames: plan.skills.map((skill) => skill.name),
    cardinality: plan.skills.length,
    rejected: plan.rejected,
    ...(plan.diagnostics?.fallbackReason
      ? { fallbackReason: sanitizeSecrets(plan.diagnostics.fallbackReason).slice(0, 240) }
      : {}),
    ...(plan.diagnostics?.rejectionReason
      ? { rejectionReason: sanitizeSecrets(plan.diagnostics.rejectionReason).slice(0, 240) }
      : {}),
    ...(plan.diagnostics?.latencyMs === undefined ? {} : { latencyMs: plan.diagnostics.latencyMs }),
    ...(plan.diagnostics?.injectedChars === undefined
      ? {}
      : { injectedChars: plan.diagnostics.injectedChars }),
  };
}
