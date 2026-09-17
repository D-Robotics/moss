/**
 * SeedToolsNudge — mid-run reminder when the user asked to seed the database
 * but no seed-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedSeedCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const SEED_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const SEED_USER_RE =
  /(?:\bseed\b|\bprisma db seed\b|\bknex seed\b|\bnpm run seed\b|灌数|种子数据|seed 数据库|seed the (?:db|database))/iu;

const SEED_ACTION_RE = /(?:run|execute|seed|灌|写入)/iu;

export type SeedToolsNudgeRequest = NudgeRequest;
export type SeedToolsNudgeResult = NudgeResult;

function sawSeedExec(messages: NudgeMessage[] | undefined): boolean {
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
}

export function evaluateSeedToolsNudge(request: SeedToolsNudgeRequest): SeedToolsNudgeResult {
  if (request.attempts >= SEED_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawSeedExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !SEED_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, SEED_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to seed the database, and tools have already run without a seed-shaped command ' +
      '(`prisma db seed`, `knex seed`, `npm run seed`, etc.). ' +
      'Run the real seed via `exec` and report its output, or clearly say seeding was skipped. ' +
      'Do not invent seed success.',
  };
}
