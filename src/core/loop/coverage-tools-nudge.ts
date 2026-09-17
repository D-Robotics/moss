/**
 * CoverageToolsNudge — mid-run reminder when the user asked for coverage
 * but no coverage-shaped exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCoverageCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const COVERAGE_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const COVERAGE_USER_RE =
  /(?:\bcoverage\b|\bnyc\b|\bc8\b|\bistanbul\b|--coverage|覆盖率|跑覆盖率)/iu;

const COVERAGE_ACTION_RE = /(?:run|measure|collect|please|now|帮我|请|现在|跑)/iu;

export type CoverageToolsNudgeRequest = NudgeRequest;
export type CoverageToolsNudgeResult = NudgeResult;

function sawCoverageEvidence(
  byName: Record<string, number>,
  messages: NudgeMessage[] | undefined
): boolean {
  if ((byName.run_tests ?? 0) > 0 || (byName.verify_fix ?? 0) > 0) return true;
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\bcoverage\b/i.test(cmd) ||
      /\b(?:nyc|c8|istanbul)\b/i.test(cmd) ||
      /\b(?:jest|vitest)\b[^\n]*--coverage\b/i.test(cmd) ||
      /\bnpm run (?:test:)?coverage\b|\bpnpm (?:run )?(?:test:)?coverage\b|\byarn (?:test:)?coverage\b/i.test(
        cmd
      )
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateCoverageToolsNudge(
  request: CoverageToolsNudgeRequest
): CoverageToolsNudgeResult {
  if (request.attempts >= COVERAGE_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawCoverageEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !COVERAGE_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, COVERAGE_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked for test coverage, and tools have already run without a coverage-shaped command ' +
      '(`--coverage`, `c8`, `nyc`, `npm run coverage`, etc.) or `run_tests`/`verify_fix`. ' +
      'Run real coverage and report the numbers, or clearly say coverage was not measured. ' +
      'Do not invent coverage percentages.',
  };
}
