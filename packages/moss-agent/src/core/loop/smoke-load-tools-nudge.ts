/**
 * SmokeLoadToolsNudge — mid-run reminder when the user asked for smoke/load/perf
 * tests but no matching smoke/load exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedSmokeLoadCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const SMOKE_LOAD_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const SMOKE_LOAD_USER_RE =
  /(?:\bsmoke tests?\b|\bload tests?\b|\bperf(?:ormance)? tests?\b|\bk6\b|\bartillery\b|\bwrk\b|冒烟测试|压测|跑冒烟)/iu;

const SMOKE_LOAD_ACTION_RE = /(?:run|please|now|帮我|请|现在|跑)/iu;

export type SmokeLoadToolsNudgeRequest = NudgeRequest;
export type SmokeLoadToolsNudgeResult = NudgeResult;

function sawSmokeLoadEvidence(
  byName: Record<string, number>,
  messages: NudgeMessage[] | undefined,
): boolean {
  if ((byName.run_tests ?? 0) > 0 || (byName.verify_fix ?? 0) > 0) return true;
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\bsmoke\b/i.test(cmd) ||
      /\b(?:k6|artillery|wrk|ab|hey|vegeta|locust)\b/i.test(cmd) ||
      /\bnpm run (?:smoke|test:smoke|load|perf)\b|\bpnpm (?:run )?(?:smoke|test:smoke|load|perf)\b|\byarn (?:smoke|test:smoke|load|perf)\b/i.test(
        cmd,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateSmokeLoadToolsNudge(
  request: SmokeLoadToolsNudgeRequest,
): SmokeLoadToolsNudgeResult {
  if (request.attempts >= SMOKE_LOAD_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawSmokeLoadEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !SMOKE_LOAD_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, SMOKE_LOAD_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked for smoke/load/perf tests, and tools have already run without a matching smoke/load command ' +
      '(`npm run smoke`, `k6`, `artillery`, `wrk`, etc.) or `run_tests`/`verify_fix`. ' +
      'Run the real smoke/load suite and report its output, or clearly say it was not run. ' +
      'Do not invent smoke/load results.',
  };
}
