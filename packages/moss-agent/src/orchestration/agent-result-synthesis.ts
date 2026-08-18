import type {
  AgentClaim,
  AgentResult,
  AgentResultConflict,
  AgentSynthesisResult,
  AssignmentSpec,
} from './agent-role-types.js';

function conflictSeverity(claims: readonly AgentClaim[]): 'low' | 'medium' | 'high' {
  if (claims.some((claim) => claim.severity === 'high')) return 'high';
  if (claims.some((claim) => claim.severity === 'medium')) return 'medium';
  return 'low';
}

/** Synthesize structured results without converting partial work into success. @beta */
export function synthesizeAgentResults(input: {
  readonly assignments: readonly AssignmentSpec[];
  readonly results: readonly AgentResult[];
}): AgentSynthesisResult {
  const resultsByAssignment = new Map(input.results.map((result) => [result.assignmentId, result]));
  const acceptedEvidenceIds = [...new Set(input.results.flatMap((result) => result.evidenceRefs))];
  const missingCriteria = new Set<string>();
  for (const assignment of input.assignments) {
    const result = resultsByAssignment.get(assignment.id);
    if (!result || result.status === 'FAIL') {
      for (const criterion of assignment.acceptanceCriteria) missingCriteria.add(criterion);
      continue;
    }
    if (result.status === 'PARTIAL') {
      for (const criterion of result.unmetCriteria) missingCriteria.add(criterion);
    }
  }

  const claimsBySubject = new Map<string, AgentClaim[]>();
  for (const claim of input.results.flatMap((result) => result.claims)) {
    const claims = claimsBySubject.get(claim.subject) ?? [];
    claims.push(claim);
    claimsBySubject.set(claim.subject, claims);
  }
  const conflicts: AgentResultConflict[] = [];
  const verifierAssignments: AssignmentSpec[] = [];
  for (const [subject, claims] of claimsBySubject) {
    if (new Set(claims.map((claim) => claim.conclusion)).size < 2) continue;
    const severity = conflictSeverity(claims);
    const evidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceRefs))];
    conflicts.push({
      subject,
      severity,
      claimIds: claims.map((claim) => claim.id),
      evidenceIds,
    });
    if (severity === 'high') {
      const first = input.assignments[0];
      verifierAssignments.push({
        id: `verify-conflict-${subject}`,
        graphId: first?.graphId ?? 'unknown',
        nodeId: `verify-conflict-${subject}`,
        goal: `Independently resolve conflicting claims about ${subject}`,
        requiredRoleKind: 'verifier',
        requiredCapabilities: [],
        inputEvidenceIds: evidenceIds,
        dependencies: [],
        writePaths: [],
        acceptanceCriteria: [`resolve-conflict:${subject}`],
      });
    }
  }
  const criteria = [...new Set(input.assignments.flatMap((item) => item.acceptanceCriteria))];
  const missing = [...missingCriteria].sort();
  const coverage = criteria.length === 0 ? 1 : (criteria.length - missing.length) / criteria.length;
  return {
    coverage,
    acceptedEvidenceIds,
    missingCriteria: missing,
    conflicts,
    verifierAssignments,
  };
}
