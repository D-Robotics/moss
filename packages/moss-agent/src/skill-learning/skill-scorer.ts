





import type { SkillCandidateEvidence, SkillCandidateToolCall } from './skill-candidate-store.js';

export interface SkillScoreResult {
  confidence: number;
  signals: {
    toolCallCount: number;
    distinctTools: number;
    errorRecovered: boolean;
    patternOccurrences: number;
    hasVerification: boolean;
    allSucceeded: boolean;

    failedCount: number;

    unrecoveredFailure: boolean;
    sameToolNoRetry?: boolean;
    differentToolRecovery?: boolean;
  };
  errorRecoveryPatterns: string[];
  preconditions: string[];
}

const HIGH_CONFIDENCE_THRESHOLD = 0.7;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5;

export function isHighConfidence(score: SkillScoreResult): boolean {
  return score.confidence >= HIGH_CONFIDENCE_THRESHOLD;
}

export function isMediumConfidence(score: SkillScoreResult): boolean {
  return score.confidence >= MEDIUM_CONFIDENCE_THRESHOLD;
}

/**
 * Scores a skill candidate based on evidence quality, error recovery, and verification.
 *
 * Confidence scoring layers (0-1 scale):
 * - Base: 0.3 (any complete skill attempt)
 * - Process: +0.15 (4+ tools) or +0.1 (3+ tools), +0.12-0.2 (error recovery)
 * - Reliability: +0.3 (3+ occurrences) or +0.15 (2+ occurrences)
 * - Quality: +0.1 (diverse tools), +0.05-0.1 (verification), +0.1-0.15 (teaching notes)
 * - Penalty: ×0.8 (ends with failure), ×0.6 (>50% failures), ×0.7 (unrecovered same-tool failure)
 *
 * Design rationale:
 * - Same-tool retry (+0.2) is stronger signal than different-tool recovery (+0.12)
 * - Pattern recurrence drives confidence more than single-run perfection
 * - Verification bonus is quality-dependent: strong(exec) > medium(read) > weak(search)
 * - Penalties are multiplicative, not hard caps, allowing partial credit for recovery attempts
 */
export function scoreSkillCandidate(
  evidence: SkillCandidateEvidence,
  patternOccurrences: number = 1
): SkillScoreResult {
  const toolCalls = evidence.toolCalls;
  const distinctTools = new Set(toolCalls.map((tc) => tc.name)).size;
  const { errorRecovered, hasDifferentToolRecovery } = detectErrorRecovery(toolCalls);
  const { hasVerification, verificationQuality } = detectVerification(toolCalls);
  const allSucceeded = toolCalls.every((tc) => !tc.failed);
  const failedCount = toolCalls.filter((tc) => tc.failed).length;
  const endsWithFailure = toolCalls.length > 0 && toolCalls[toolCalls.length - 1].failed === true;

  // Detect recovery types: same-tool retry vs. different-tool recovery
  const sameToolNoRetry = toolCalls.some(
    (tc, i) =>
      tc.failed && !toolCalls.slice(i + 1).some((later) => later.name === tc.name && !later.failed)
  );
  const differentToolRecovery = hasDifferentToolRecovery;

  // Legacy name for backward compatibility
  const unrecoveredFailure = sameToolNoRetry && !errorRecovered;

  let confidence = 0.3;

  if (toolCalls.length >= 4) confidence += 0.15;
  else if (toolCalls.length >= 3) confidence += 0.1;

  // Reward error recovery with differentiation by type
  if (errorRecovered) {
    if (differentToolRecovery) {
      // Different tool recovery is weaker signal than same-tool retry
      confidence += 0.12;
    } else {
      // Same-tool retry is a strong signal of deliberate error handling
      confidence += 0.2;
    }
  }

  if (patternOccurrences >= 3) confidence += 0.3;
  else if (patternOccurrences >= 2) confidence += 0.15;

  if (distinctTools >= 3) confidence += 0.1;

  if (allSucceeded && toolCalls.length >= 3) confidence += 0.1;

  // Reward verification with quality-based bonus
  if (hasVerification) {
    confidence += verificationQuality === 'strong' ? 0.1 : verificationQuality === 'medium' ? 0.07 : 0.05;
  }

  if (evidence.teachingMeta) {
    const hasPreAnnotations =
      evidence.teachingMeta.preAnnotations && evidence.teachingMeta.preAnnotations.length > 0;
    const hasPostAnnotations =
      evidence.teachingMeta.postAnnotations && evidence.teachingMeta.postAnnotations.length > 0;
    if (hasPreAnnotations && hasPostAnnotations) confidence += 0.1;
    else if (hasPreAnnotations || hasPostAnnotations) confidence += 0.05;

    if (hasPostAnnotations) {
      const highConfPosts = evidence.teachingMeta.postAnnotations!.filter(
        (a) => a.confidence === 'high'
      ).length;
      if (highConfPosts >= 2) confidence += 0.05;
    }
  }

  if (evidence.runMeta.completionKind === 'complete') {
    confidence += 0.05;
  }

  // Apply differentiated penalties for failures
  if (endsWithFailure) {
    confidence *= 0.8;
  } else if (failedCount > 0 && failedCount / toolCalls.length > 0.5) {
    confidence *= 0.6;
  } else if (sameToolNoRetry && !errorRecovered) {
    // Only penalize if truly unrecovered (no same-tool retry, no different-tool recovery)
    confidence *= 0.7;
  }

  confidence = Math.min(1, Math.max(0, confidence));

  return {
    confidence: Math.round(confidence * 100) / 100,
    signals: {
      toolCallCount: toolCalls.length,
      distinctTools,
      errorRecovered,
      patternOccurrences,
      hasVerification,
      allSucceeded,
      failedCount,
      unrecoveredFailure,
      sameToolNoRetry,
      differentToolRecovery,
    },
    errorRecoveryPatterns: extractErrorRecoveryPatterns(toolCalls),
    preconditions: extractPreconditions(toolCalls),
  };
}




interface ErrorRecoveryInfo {
  errorRecovered: boolean;
  hasDifferentToolRecovery: boolean;
}

interface VerificationInfo {
  hasVerification: boolean;
  verificationQuality: 'strong' | 'medium' | 'weak';
}

// Verification tools by strength: exec/device_exec run real code, read tools inspect artifacts, search tools query info
const STRONG_VERIFICATION_TOOLS = new Set(['exec', 'device_exec', 'bash_exec']);
const MEDIUM_VERIFICATION_TOOLS = new Set([
  'read',
  'read_file',
  'device_file_read',
  'list_directory',
  'web_fetch',
]);
const WEAK_VERIFICATION_TOOLS = new Set(['grep', 'search_code', 'search_files', 'web_search', 'memory_read']);

// Tool substitution groups: tools that can replace each other in error recovery.
const TOOL_SUBSTITUTION_GROUPS: Record<string, string[]> = {
  exec: ['exec', 'device_exec', 'bash_exec'],
  device_exec: ['exec', 'device_exec', 'bash_exec'],
  bash_exec: ['exec', 'device_exec', 'bash_exec'],
  read: ['read', 'read_file', 'device_file_read', 'web_fetch'],
  device_file_read: ['read', 'read_file', 'device_file_read', 'web_fetch'],
};

function detectErrorRecovery(toolCalls: SkillCandidateToolCall[]): ErrorRecoveryInfo {
  let errorRecovered = false;
  let hasDifferentToolRecovery = false;

  for (let i = 0; i < toolCalls.length; i++) {
    if (!toolCalls[i].failed) continue;
    const failedToolName = toolCalls[i].name;
    const laterTools = toolCalls.slice(i + 1);

    // Check for same-tool retry success
    if (laterTools.some((tc) => tc.name === failedToolName && !tc.failed)) {
      errorRecovered = true;
      continue;
    }

    // Check for different-tool recovery (tool substitution or diagnostic recovery)
    const substitutionGroup = TOOL_SUBSTITUTION_GROUPS[failedToolName];
    if (substitutionGroup) {
      // Check if any tool in the substitution group succeeds
      const differentToolSuccess = laterTools.some(
        (tc) =>
          substitutionGroup.includes(tc.name) &&
          tc.name !== failedToolName &&
          !tc.failed
      );
      if (differentToolSuccess) {
        errorRecovered = true;
        hasDifferentToolRecovery = true;
        continue;
      }
    }

    // Check for diagnostic recovery: failed tool → read/grep/search → original/different tool success
    const hasIntermediateDiagnostic = laterTools.some(
      (tc, j) =>
        ['read', 'read_file', 'grep', 'search_code', 'search_files'].includes(tc.name) &&
        !tc.failed &&
        laterTools.slice(j + 1).some((final) => {
          const successTool = substitutionGroup?.includes(final.name) ?? final.name === failedToolName;
          return successTool && !final.failed;
        })
    );
    if (hasIntermediateDiagnostic) {
      errorRecovered = true;
      hasDifferentToolRecovery = true;
    }
  }

  return { errorRecovered, hasDifferentToolRecovery };
}

function extractErrorRecoveryPatterns(toolCalls: SkillCandidateToolCall[]): string[] {
  const patterns: string[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    if (!toolCalls[i].failed) continue;

    const failedToolName = toolCalls[i].name;
    const laterTools = toolCalls.slice(i + 1);

    // Case 1: Same-tool retry success
    const sameToolRetryIdx = laterTools.findIndex((tc) => tc.name === failedToolName && !tc.failed);
    if (sameToolRetryIdx !== -1) {
      const via = laterTools
        .slice(0, sameToolRetryIdx)
        .filter((tc) => !tc.failed)
        .map((tc) => tc.name);
      const pattern =
        via.length > 0
          ? `${failedToolName} failed → recovered with ${via.join(', ')} → ${failedToolName} succeeded (retry)`
          : `${failedToolName} failed → recovered with ${failedToolName} (immediate retry)`;
      patterns.push(pattern);
      continue;
    }

    // Case 2: Different-tool recovery (substitution)
    const substitutionGroup = TOOL_SUBSTITUTION_GROUPS[failedToolName];
    if (substitutionGroup) {
      const substitutionIdx = laterTools.findIndex(
        (tc) =>
          substitutionGroup.includes(tc.name) &&
          tc.name !== failedToolName &&
          !tc.failed
      );
      if (substitutionIdx !== -1) {
        const via = laterTools
          .slice(0, substitutionIdx)
          .filter((tc) => !tc.failed)
          .map((tc) => tc.name);
        const recoveredTool = laterTools[substitutionIdx].name;
        const pattern =
          via.length > 0
            ? `${failedToolName} failed → recovered with ${via.join(', ')} → ${recoveredTool} succeeded (substitution)`
            : `${failedToolName} failed → recovered with ${recoveredTool} (tool substitution)`;
        patterns.push(pattern);
        continue;
      }
    }

    // Case 3: Diagnostic recovery (read/grep → retry)
    const diagnosticTools = ['read', 'read_file', 'grep', 'search_code', 'search_files'];
    for (let j = i + 1; j < toolCalls.length; j++) {
      if (!toolCalls[j].failed && diagnosticTools.includes(toolCalls[j].name)) {
        // Found diagnostic step, now find retry/recovery
        const recoveryIdx = toolCalls.slice(j + 1).findIndex((tc) => {
          const isSameTool = tc.name === failedToolName;
          const isSubstitution =
            substitutionGroup?.includes(tc.name) ?? false;
          return !tc.failed && (isSameTool || isSubstitution);
        });
        if (recoveryIdx !== -1) {
          const actualRecoveryIdx = j + 1 + recoveryIdx;
          const diagnostics = toolCalls
            .slice(i + 1, actualRecoveryIdx)
            .filter((tc) => diagnosticTools.includes(tc.name) && !tc.failed)
            .map((tc) => tc.name);
          const recoveryTool = toolCalls[actualRecoveryIdx].name;
          const pattern =
            diagnostics.length > 0
              ? `${failedToolName} failed → diagnosed with ${diagnostics.join(', ')} → ${recoveryTool} succeeded`
              : `${failedToolName} failed → retried as ${recoveryTool} → succeeded`;
          patterns.push(pattern);
          break;
        }
      }
    }
  }

  return patterns;
}

function detectVerification(toolCalls: SkillCandidateToolCall[]): VerificationInfo {
  let maxQuality: 'strong' | 'medium' | 'weak' | null = null;

  for (const tc of toolCalls) {
    if (tc.failed) continue;

    if (STRONG_VERIFICATION_TOOLS.has(tc.name)) {
      return { hasVerification: true, verificationQuality: 'strong' };
    }
    if (MEDIUM_VERIFICATION_TOOLS.has(tc.name)) {
      maxQuality = 'medium';
    }
    if (WEAK_VERIFICATION_TOOLS.has(tc.name) && !maxQuality) {
      maxQuality = 'weak';
    }
  }

  if (maxQuality) {
    return { hasVerification: true, verificationQuality: maxQuality };
  }

  return { hasVerification: false, verificationQuality: 'weak' };
}

function extractPreconditions(toolCalls: SkillCandidateToolCall[]): string[] {
  const preconditions: string[] = [];
  const first = toolCalls[0];
  if (!first) return preconditions;

  if (first.name === 'read' || first.name === 'device_file_read') {
    const filePath = String(first.input.file_path || first.input.path || '');
    if (filePath) preconditions.push(`File exists: ${filePath}`);
  }
  if (first.name === 'device_exec') {
    preconditions.push('Device SSH connected');
  }
  return preconditions;
}
