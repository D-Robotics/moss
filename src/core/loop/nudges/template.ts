/**
 * Declarative template for tool-shaped nudges.
 *
 * Every merged nudge's evaluate body is a side-effect-free negative
 * conjunction: attempts guard → totalToolCalls guard → evidence check →
 * user-regex match → conceptual-question exemption → correction. Conjunctions
 * of pure negative guards are order-independent, so this template is
 * semantically equivalent to the copy-pasted implementations it replaces.
 */

import { isConceptualQuestion } from '../nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from '../nudge-helpers.js';

/** All template-based tools nudges fire at most once per run. */
export const TOOLS_NUDGE_MAX_ATTEMPTS = 1;

/** Evidence inputs passed to a spec's sawEvidence predicate. */
export interface NudgeEvidenceContext {
  messages: NudgeMessage[] | undefined;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
}

export interface ToolsNudgeSpec {
  /** User request regex (verbatim from the original X_USER_RE). */
  userRe: RegExp;
  /** Action-words regex (original X_ACTION_RE; opts into the conceptual-question exemption). */
  actionRe?: RegExp;
  /** Evidence predicate (verbatim from the original saw* function body). */
  sawEvidence: (ctx: NudgeEvidenceContext) => boolean;
  /** Extra user-text exemption (e.g. git status-only asks), optional. */
  extraUserExempt?: (userText: string) => boolean;
  /** Correction message injected on fire (verbatim from the original). */
  correction: string;
}

export function defineToolsNudge(spec: ToolsNudgeSpec): (request: NudgeRequest) => NudgeResult {
  return function evaluate(request: NudgeRequest): NudgeResult {
    if (request.attempts >= TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
    if (request.totalToolCalls < 1) return { fire: false };
    if (
      spec.sawEvidence({
        messages: request.messages,
        toolCallsByName: request.toolCallsByName,
        totalToolCalls: request.totalToolCalls,
      })
    ) {
      return { fire: false };
    }
    const user = (request.userText || '').trim();
    if (!user || !spec.userRe.test(user)) return { fire: false };
    if (spec.actionRe && isConceptualQuestion(user, spec.actionRe)) return { fire: false };
    if (spec.extraUserExempt && spec.extraUserExempt(user)) return { fire: false };
    return { fire: true, correction: spec.correction };
  };
}
