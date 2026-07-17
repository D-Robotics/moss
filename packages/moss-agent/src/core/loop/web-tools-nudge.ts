/**
 * WebToolsNudge — mid-run reminder when the user asked for online research
 * but no web_search / web_fetch has run yet.
 *
 * Soft: max 1 fire per run. Pairs with evaluateWebToolsCompletionGate.
 */

export const WEB_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

const WEB_USER_RE =
  /(?:web_?search|web_?fetch|search the web|look up online|google|bing|搜一下|联网|网上|官网|文档站|https?:\/\/|查(一下|下).*(新闻|资料|文档)|搜索(一下|下)?)/iu;

export interface WebToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
  attempts: number;
}

export type WebToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function countWebTools(byName: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (WEB_TOOLS.has(name)) n += count;
  }
  return n;
}

export function evaluateWebToolsNudge(request: WebToolsNudgeRequest): WebToolsNudgeResult {
  if (request.attempts >= WEB_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (countWebTools(request.toolCallsByName) > 0) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !WEB_USER_RE.test(user)) return { fire: false };

  // Pure conceptual questions without asking to look anything up.
  if (
    /(?:what is|how does|why is|文档原理|介绍一下)/iu.test(user) &&
    !/(?:search|look up|find online|搜|查|官网|https?:)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked for online lookup/research, but no `web_search` / `web_fetch` has run this turn. ' +
      'Use `web_search` (optionally with `query_keyword_groups`) then `web_fetch` with `focus` for depth, ' +
      'or clearly answer from local knowledge only — do not invent web results or cite URLs you did not retrieve.',
  };
}
