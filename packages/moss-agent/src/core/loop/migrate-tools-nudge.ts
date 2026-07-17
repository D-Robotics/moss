/**
 * MigrateToolsNudge — mid-run reminder when the user asked to run DB migrations
 * but no migrate-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedMigrateCompletionGate.
 */

export const MIGRATE_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const MIGRATE_USER_RE =
  /(?:\bmigrate\b|\bmigrations?\b|\bprisma migrate\b|\bdrizzle-kit\b|\bknex migrate\b|\balembic\b|跑迁移|执行迁移|数据库迁移)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface MigrateToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type MigrateToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawMigrateExec(
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
        /\bmigrate\b/i.test(cmd) ||
        /\bprisma\s+migrate\b/i.test(cmd) ||
        /\bdrizzle-kit\b/i.test(cmd) ||
        /\bknex\s+migrate\b/i.test(cmd) ||
        /\balembic\s+upgrade\b/i.test(cmd) ||
        /\btypeorm\s+migration\b/i.test(cmd)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateMigrateToolsNudge(
  request: MigrateToolsNudgeRequest,
): MigrateToolsNudgeResult {
  if (request.attempts >= MIGRATE_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawMigrateExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !MIGRATE_USER_RE.test(user)) return { fire: false };

  // Conceptual "what is a migration?" without asking to apply.
  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|apply|execute|deploy|跑|执行|应用)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked to run database migrations, and tools have already run without a migrate-shaped command ' +
      '(`prisma migrate`, `drizzle-kit`, `knex migrate`, `alembic upgrade`, etc.). ' +
      'Run the real migration via `exec` and report its output, or clearly say migrations were not applied. ' +
      'Do not invent migration success.',
  };
}
