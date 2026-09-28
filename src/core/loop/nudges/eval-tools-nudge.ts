/**
 * EvalToolsNudge — mid-run reminder when the user asked to run an eval /
 * benchmark suite but the `eval` tool has not been used.
 *
 * Soft: max 1 fire. Pairs with evaluatePlanEvalCompletionGate (eval branch).
 */

import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const EVAL_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type EvalToolsNudgeRequest = NudgeRequest;
export type EvalToolsNudgeResult = NudgeResult;

export const evaluateEvalToolsNudge = defineToolsNudge({
  userRe:
    /(?:\beval\b|\bevaluation suite\b|\bbenchmark suite\b|跑评测|评估套件|评测套件|跑一下 eval)/iu,
  actionRe: /(?:run|execute|define|report|跑|执行)/iu,
  sawEvidence: ({ toolCallsByName }) => (toolCallsByName.eval ?? 0) > 0,
  correction:
    '[System] The user asked to run/define an eval or benchmark suite, and tools have already run without the `eval` tool. ' +
    'Use `eval` (define / run / auto / report) for formal suite results, or clearly say you are not using the eval tool. ' +
    'Do not invent benchmark scores or suite pass/fail.',
});
