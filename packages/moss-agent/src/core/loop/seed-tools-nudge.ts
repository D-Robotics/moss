/**
 * SeedToolsNudge — mid-run reminder when the user asked to seed the database
 * but no seed-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedSeedCompletionGate.
 */

export const SEED_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const SEED_USER_RE =
  /(?:\bseed\b|\bprisma db seed\b|\bknex seed\b|\bnpm run seed\b|灌数|种子数据|seed 数据库|seed the (?:db|database))/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface SeedToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type SeedToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawSeedExec(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): boolean {
  if (!messages?.length) return false;
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
        /\bseed\b/i.test(cmd) ||
        /\bprisma\s+db\s+seed\b/i.test(cmd) ||
        /\bknex\s+seed\b/i.test(cmd) ||
        /\bnpm run seed\b|\bpnpm (?:run )?seed\b|\byarn seed\b/i.test(cmd)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateSeedToolsNudge(request: SeedToolsNudgeRequest): SeedToolsNudgeResult {
  if (request.attempts >= SEED_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawSeedExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !SEED_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|execute|seed|灌|写入)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked to seed the database, and tools have already run without a seed-shaped command ' +
      '(`prisma db seed`, `knex seed`, `npm run seed`, etc.). ' +
      'Run the real seed via `exec` and report its output, or clearly say seeding was skipped. ' +
      'Do not invent seed success.',
  };
}
