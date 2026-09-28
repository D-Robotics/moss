/**
 * MigrateToolsNudge — mid-run reminder when the user asked to run DB migrations
 * but no migrate-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedMigrateCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const MIGRATE_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type MigrateToolsNudgeRequest = NudgeRequest;
export type MigrateToolsNudgeResult = NudgeResult;

export const evaluateMigrateToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bmigrate\b|\bmigrations?\b|\bprisma migrate\b|\bdrizzle-kit\b|\bknex migrate\b|\balembic\b|跑迁移|执行迁移|数据库迁移)/iu,
  actionRe: /(?:run|apply|execute|deploy|跑|执行|应用)/iu,
  sawEvidence: ({ messages }) => {
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
  },
  correction:
    '[System] The user asked to run database migrations, and tools have already run without a migrate-shaped command ' +
    '(`prisma migrate`, `drizzle-kit`, `knex migrate`, `alembic upgrade`, etc.). ' +
    'Run the real migration via `exec` and report its output, or clearly say migrations were not applied. ' +
    'Do not invent migration success.',
});
