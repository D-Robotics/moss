/**
 * WebToolsNudge — mid-run reminder when the user asked for online research
 * but no web_search / web_fetch has run yet.
 *
 * Soft: max 1 fire per run. Pairs with evaluateWebToolsCompletionGate.
 */

import { defineToolsNudge } from './template.js';

const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

function countWebTools(byName: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (WEB_TOOLS.has(name)) n += count;
  }
  return n;
}

export const evaluateWebToolsNudge = defineToolsNudge({
  userRe:
    /(?:web_?search|web_?fetch|search the web|look up online|google|bing|搜一下|联网|网上|官网|文档站|https?:\/\/|查(一下|下).*(新闻|资料|文档)|搜索(一下|下)?)/iu,
  sawEvidence: ({ toolCallsByName }) => countWebTools(toolCallsByName) > 0,
  // Pure conceptual questions without asking to look anything up.
  extraUserExempt: (user) =>
    /(?:what is|how does|why is|文档原理|介绍一下)/iu.test(user) &&
    !/(?:search|look up|find online|搜|查|官网|https?:)/iu.test(user),
  correction:
    '[System] The user asked for online lookup/research, but no `web_search` / `web_fetch` has run this turn. ' +
    'Use `web_search` (optionally with `query_keyword_groups`) then `web_fetch` with `focus` for depth, ' +
    'or clearly answer from local knowledge only — do not invent web results or cite URLs you did not retrieve.',
});
