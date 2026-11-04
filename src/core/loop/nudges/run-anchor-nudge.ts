/**
 * RunAnchorNudge — one mid-run objective re-anchor for deep runs.
 *
 * Qoder conversation mining (2026-11-04) showed `goal_state` is the single
 * most frequent runtime injection (9021 occurrences across 476 sessions):
 * every LLM turn re-carries objective + progress. Moss carries the objective
 * exactly once, in the run's opening user message, so a long tool loop can
 * drift without noticing. Instead of re-serializing state the model already
 * has, this nudge is a pointer: re-read the original instruction and name
 * what still blocks completion. Fires at most once per run.
 */

import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';

/** LLM turns in this run before the anchor fires. */
export const RUN_ANCHOR_TURN_THRESHOLD = 20;

/** Minimum tool calls — pure chat or light runs never drift enough to pay. */
export const RUN_ANCHOR_MIN_TOOL_CALLS = 8;

export interface RunAnchorNudgeRequest extends NudgeRequest {
  turns: number;
}

export function evaluateRunAnchorNudge(request: RunAnchorNudgeRequest): NudgeResult {
  if (request.attempts >= 1) return { fire: false };
  if (request.turns < RUN_ANCHOR_TURN_THRESHOLD) return { fire: false };
  if (request.totalToolCalls < RUN_ANCHOR_MIN_TOOL_CALLS) return { fire: false };
  return {
    fire: true,
    correction:
      `[System] This run is now ${request.turns} turns deep. Before the next action, re-read the ` +
      'original instruction that started this run (the first user message) and check it against what you ' +
      'are doing right now. Name the one thing that still blocks completion of that instruction; if the ' +
      'current work no longer serves it, stop and course-correct instead of finishing the detour.',
  };
}
