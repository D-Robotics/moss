/**
 * Plan-mode prompt text for the dynamic suffix.
 *
 * The layer lives in `PromptAssembler` under the stable id `mode:plan`, so the
 * registry — not an index — owns its slot: entering and leaving plan mode
 * replaces one declaration and never grows the suffix, and the stable prefix is
 * untouched (a `/mode` switch must not invalidate the cached prefix).
 */
import { PLAN_MODE_PROMPT } from '../contracts/prompts/plan-mode-prompt.js';
import type { CliInteractionMode } from './interaction-mode.js';

/** The prompt text for a mode: the plan contract, or nothing outside plan mode. */
export function planModeLayer(mode: CliInteractionMode): string {
  return mode === 'plan' ? PLAN_MODE_PROMPT : '';
}
