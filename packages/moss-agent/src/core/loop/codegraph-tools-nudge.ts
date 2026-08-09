/**
 * CodegraphToolsNudge — mid-run reminder when the user asked for call-graph /
 * CodeGraph navigation but no codegraph_* tools have run.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCodegraphCompletionGate.
 * Does not fire when search_code alone is clearly sufficient for a simple text search.
 */

import { isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const CODEGRAPH_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const CODEGRAPH_USER_RE =
  /(?:\bcallers?\b|\bcallees?\b|\bcall graph\b|\bcodegraph\b|\bwho calls\b|\bwhat calls\b|调用图|谁调用|调用谁|依赖影响|impact of)/iu;

const CODEGRAPH_ACTION_RE =
  /(?:find|show|list|trace|who calls|what calls|callers? of|callees? of|查|找)/iu;

export type CodegraphToolsNudgeRequest = NudgeRequest;
export type CodegraphToolsNudgeResult = NudgeResult;

function usedCodegraph(byName: Record<string, number>): boolean {
  return Object.keys(byName).some((n) => n.startsWith('codegraph_'));
}

export function evaluateCodegraphToolsNudge(
  request: CodegraphToolsNudgeRequest
): CodegraphToolsNudgeResult {
  if (request.attempts >= CODEGRAPH_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (usedCodegraph(request.toolCallsByName)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !CODEGRAPH_USER_RE.test(user)) return { fire: false };

  // Conceptual "what is a call graph?" without asking to query the repo.
  // Note: avoid using bare \bwhat\b here — it matches "what is …".
  if (isConceptualQuestion(user, CODEGRAPH_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked for call-graph / callers / callees / impact-style navigation, and tools have already run without any `codegraph_*` tools. ' +
      'Prefer `codegraph_callers` / `codegraph_callees` / `codegraph_trace` / `codegraph_impact` / `codegraph_search` for structural answers. ' +
      '`search_code` alone is text search — do not present its hits as a verified call graph unless you used CodeGraph (or clearly say it is text search only).',
  };
}
