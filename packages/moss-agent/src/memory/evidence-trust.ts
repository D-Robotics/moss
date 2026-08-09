export type ExecutionDomain = 'local' | 'simulation' | 'real';

export interface EvidenceTrustBoundary {
  executionDomain?: ExecutionDomain;
  realEvidenceEligible?: boolean;
}

/** Bundled RDK contracts operate on a physical board unless a future Skill
 * explicitly declares a different trust policy. */
export function requiresRealDeviceEvidence(skill: string | undefined): boolean {
  return Boolean(skill && (/^rdk-/i.test(skill) || /^rk-/i.test(skill)));
}

export function isRealEvidenceEligible(
  input: EvidenceTrustBoundary & {
    environmentFingerprint?: string;
    environmentCompleteness?: 'complete' | 'incomplete' | 'legacy';
  }
): boolean {
  return (
    input.executionDomain === 'real' &&
    input.realEvidenceEligible === true &&
    Boolean(input.environmentFingerprint && input.environmentFingerprint !== 'unknown') &&
    input.environmentCompleteness === 'complete'
  );
}
