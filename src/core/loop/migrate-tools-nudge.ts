/**
 * MigrateToolsNudge — mid-run reminder when the user asked to run DB migrations
 * but no migrate-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedMigrateCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const MIGRATE_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const MIGRATE_USER_RE =
  /(?:\bmigrate\b|\bmigrations?\b|\bprisma migrate\b|\bdrizzle-kit\b|\bknex migrate\b|\balembic\b|跑迁移|执行迁移|数据库迁移)/iu;

const MIGRATE_ACTION_RE = /(?:run|apply|execute|deploy|跑|执行|应用)/iu;

export type MigrateToolsNudgeRequest = NudgeRequest;
export type MigrateToolsNudgeResult = NudgeResult;

function sawMigrateExec(messages: NudgeMessage[] | undefined): boolean {
  for (const cmd of collectExecCommands(messages)) {
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
  return false;
}

export function evaluateMigrateToolsNudge(
  request: MigrateToolsNudgeRequest
): MigrateToolsNudgeResult {
  if (request.attempts >= MIGRATE_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawMigrateExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !MIGRATE_USER_RE.test(user)) return { fire: false };

  // Conceptual "what is a migration?" without asking to apply.
  if (isConceptualQuestion(user, MIGRATE_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to run database migrations, and tools have already run without a migrate-shaped command ' +
      '(`prisma migrate`, `drizzle-kit`, `knex migrate`, `alembic upgrade`, etc.). ' +
      'Run the real migration via `exec` and report its output, or clearly say migrations were not applied. ' +
      'Do not invent migration success.',
  };
}
