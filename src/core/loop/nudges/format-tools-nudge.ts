/**
 * FormatToolsNudge — mid-run reminder when the user asked to format the code
 * but no format-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedFormatCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const FORMAT_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type FormatToolsNudgeRequest = NudgeRequest;
export type FormatToolsNudgeResult = NudgeResult;

export const evaluateFormatToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bprettier\b|\beslint\s+--fix\b|\bformat (?:the )?(?:code|files|codebase)\b|\bnpm run format\b|\bpnpm (?:run )?format\b|\byarn format\b|格式化代码|跑 prettier|格式化一下)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\bprettier\b/i.test(cmd) ||
        /\beslint\b[^\n]*--fix\b/i.test(cmd) ||
        /\b(?:gofmt|rustfmt|black|ruff\s+format|clang-format)\b/i.test(cmd) ||
        /\bnpm run format\b|\bpnpm (?:run )?format\b|\byarn format\b/i.test(cmd)
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to format the code, and tools have already run without a format-shaped command ' +
    '(`prettier`, `eslint --fix`, `npm run format`, etc.). ' +
    'Run the real formatter via `exec` and report its output, or clearly say formatting was skipped. ' +
    'Do not invent format success.',
});
