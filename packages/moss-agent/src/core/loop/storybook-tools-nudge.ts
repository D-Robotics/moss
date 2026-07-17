/**
 * StorybookToolsNudge — mid-run reminder when the user asked to run/build
 * Storybook but no storybook-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedStorybookCompletionGate.
 */

export const STORYBOOK_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const STORYBOOK_USER_RE =
  /(?:\bstorybook\b|\bbuild-storybook\b|\bnpm run storybook\b|启动 storybook|跑 storybook)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface StorybookToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type StorybookToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawStorybookExec(
  byName: Record<string, number>,
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): boolean {
  if ((byName.exec_background ?? 0) > 0) {
    // Background start may be storybook; still require storybook in command text when available.
  }
  if (!messages?.length) return (byName.exec_background ?? 0) > 0;
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || !b.name || !EXEC_TOOLS.has(b.name)) continue;
      const input = b.input;
      if (!input || typeof input !== 'object') continue;
      const o = input as Record<string, unknown>;
      let cmd = '';
      for (const key of ['command', 'cmd', 'input'] as const) {
        if (typeof o[key] === 'string' && String(o[key]).trim()) {
          cmd = String(o[key]);
          break;
        }
      }
      if (
        /\bstorybook\b/i.test(cmd) ||
        /\bnpm run storybook\b|\bpnpm (?:run )?storybook\b|\byarn storybook\b/i.test(cmd) ||
        /\bnpm run build-storybook\b|\bpnpm (?:run )?build-storybook\b|\byarn build-storybook\b/i.test(
          cmd,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateStorybookToolsNudge(
  request: StorybookToolsNudgeRequest,
): StorybookToolsNudgeResult {
  if (request.attempts >= STORYBOOK_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawStorybookExec(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !STORYBOOK_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|start|build|please|now|帮我|请|现在|启动|跑)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked to run or build Storybook, and tools have already run without a storybook-shaped command ' +
      '(`storybook`, `npm run storybook`, `build-storybook`, etc.). ' +
      'Run the real Storybook command via `exec`/`exec_background` and report its output, or clearly say Storybook was not run. ' +
      'Do not invent Storybook results.',
  };
}
