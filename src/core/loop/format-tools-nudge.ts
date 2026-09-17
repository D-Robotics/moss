/**
 * FormatToolsNudge — mid-run reminder when the user asked to format the code
 * but no format-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedFormatCompletionGate.
 */

import { collectExecCommands } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const FORMAT_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const FORMAT_USER_RE =
  /(?:\bprettier\b|\beslint\s+--fix\b|\bformat (?:the )?(?:code|files|codebase)\b|\bnpm run format\b|\bpnpm (?:run )?format\b|\byarn format\b|格式化代码|跑 prettier|格式化一下)/iu;

export type FormatToolsNudgeRequest = NudgeRequest;
export type FormatToolsNudgeResult = NudgeResult;

function sawFormatExec(messages: NudgeMessage[] | undefined): boolean {
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
}

export function evaluateFormatToolsNudge(request: FormatToolsNudgeRequest): FormatToolsNudgeResult {
  if (request.attempts >= FORMAT_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawFormatExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !FORMAT_USER_RE.test(user)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to format the code, and tools have already run without a format-shaped command ' +
      '(`prettier`, `eslint --fix`, `npm run format`, etc.). ' +
      'Run the real formatter via `exec` and report its output, or clearly say formatting was skipped. ' +
      'Do not invent format success.',
  };
}
