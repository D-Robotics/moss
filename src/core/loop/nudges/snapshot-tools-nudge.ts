/**
 * SnapshotToolsNudge — mid-run reminder when the user asked to update test
 * snapshots but no snapshot-update-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedSnapshotCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const SNAPSHOT_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type SnapshotToolsNudgeRequest = NudgeRequest;
export type SnapshotToolsNudgeResult = NudgeResult;

export const evaluateSnapshotToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bupdate(?:\s+the)?\s+snapshots?\b|\bsnapshots?\s+update\b|\bjest\s+-u\b|\bvitest\s+-u\b|--updateSnapshot|更新 snapshot|更新快照)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\b(?:jest|vitest)\b[^\n]*\s-u\b/i.test(cmd) ||
        /\b--update(?:Snapshot|s)?\b/i.test(cmd) ||
        /\bupdate[- ]?snapshots?\b/i.test(cmd) ||
        /\bnpm run (?:test:)?update-?snapshots?\b/i.test(cmd)
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to update test snapshots, and tools have already run without a snapshot-update command ' +
    '(`jest -u`, `vitest -u`, `--updateSnapshot`, etc.). ' +
    'Run the real snapshot update via `exec` and report its output, or clearly say snapshots were not updated. ' +
    'Do not invent snapshot updates.',
});
