/**
 * BackgroundServerNudge — mid-run reminder when the user asked to start a
 * long-running dev server/watcher but no exec_background (or run_in_background)
 * has been used yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedBackgroundServerCompletionGate.
 */

import type { NudgeMessage } from '../nudge-helpers.js';
import { defineToolsNudge } from './template.js';

function sawBackgroundStart(
  byName: Record<string, number>,
  messages: NudgeMessage[] | undefined
): boolean {
  if ((byName.exec_background ?? 0) > 0) return true;
  if (!messages?.length) return false;
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || b.name !== 'exec') continue;
      const input = b.input;
      if (input && typeof input === 'object') {
        const o = input as Record<string, unknown>;
        if (o.run_in_background === true || o.background === true) return true;
      }
    }
  }
  return false;
}

export const evaluateBackgroundServerNudge = defineToolsNudge({
  userRe:
    /(?:\bdev server\b|\bstart (?:the )?(?:server|service|watcher)\b|\brun (?:the )?server\b|开发服务器|启动服务|起服务|后台跑(?:服务|server)|long-running)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => sawBackgroundStart(toolCallsByName, messages),
  // Conceptual "how does the server work?" without asking to start it.
  extraUserExempt: (user) =>
    /(?:how does|what is|文档|原理|介绍)/iu.test(user) &&
    !/(?:start|run|launch|启动|起)/iu.test(user),
  correction:
    '[System] The user asked to start a long-running server/watcher, and tools have already run without `exec_background` ' +
    '(or `exec` with run_in_background). Start it in the background and report the bg handle, or clearly say it was not started. ' +
    'Do not invent a running server.',
});
