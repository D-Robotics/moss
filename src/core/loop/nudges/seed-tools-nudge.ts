/**
 * SeedToolsNudge — mid-run reminder when the user asked to seed the database
 * but no seed-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedSeedCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const SEED_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type SeedToolsNudgeRequest = NudgeRequest;
export type SeedToolsNudgeResult = NudgeResult;

export const evaluateSeedToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bseed\b|\bprisma db seed\b|\bknex seed\b|\bnpm run seed\b|灌数|种子数据|seed 数据库|seed the (?:db|database))/iu,
  actionRe: /(?:run|execute|seed|灌|写入)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\bseed\b/i.test(cmd) ||
        /\bprisma\s+db\s+seed\b/i.test(cmd) ||
        /\bknex\s+seed\b/i.test(cmd) ||
        /\bnpm run seed\b|\bpnpm (?:run )?seed\b|\byarn seed\b/i.test(cmd)
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to seed the database, and tools have already run without a seed-shaped command ' +
    '(`prisma db seed`, `knex seed`, `npm run seed`, etc.). ' +
    'Run the real seed via `exec` and report its output, or clearly say seeding was skipped. ' +
    'Do not invent seed success.',
});
