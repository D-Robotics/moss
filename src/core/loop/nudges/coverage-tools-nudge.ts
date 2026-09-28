/**
 * CoverageToolsNudge — mid-run reminder when the user asked for coverage
 * but no coverage-shaped exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCoverageCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const COVERAGE_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type CoverageToolsNudgeRequest = NudgeRequest;
export type CoverageToolsNudgeResult = NudgeResult;

export const evaluateCoverageToolsNudge = defineToolsNudge({
  userRe: /(?:\bcoverage\b|\bnyc\b|\bc8\b|\bistanbul\b|--coverage|覆盖率|跑覆盖率)/iu,
  actionRe: /(?:run|measure|collect|please|now|帮我|请|现在|跑)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    if ((toolCallsByName.run_tests ?? 0) > 0 || (toolCallsByName.verify_fix ?? 0) > 0) return true;
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
  },
  correction:
    '[System] The user asked for test coverage, and tools have already run without a coverage-shaped command ' +
    '(`--coverage`, `c8`, `nyc`, `npm run coverage`, etc.) or `run_tests`/`verify_fix`. ' +
    'Run real coverage and report the numbers, or clearly say coverage was not measured. ' +
    'Do not invent coverage percentages.',
});
