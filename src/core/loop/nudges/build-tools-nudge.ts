/**
 * BuildToolsNudge — mid-run reminder when the user asked to build/compile
 * but no build-shaped verification exec has run yet.
 *
 * Soft: max 1 fire. Complements invented-verification gate (build-succeeded claims)
 * and RunTestsToolsNudge (explicit test asks).
 */

import { VERIFY_TOOLS, collectExecCommands, countBySet } from '../nudge-helpers.js';
import { defineToolsNudge } from './template.js';

export const evaluateBuildToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bnpm run build\b|\bpnpm (?:run )?build\b|\byarn build\b|\bbun run build\b|\bcargo build\b|\bgo build\b|\bmake build\b|\bmvn (?:package|install)\b|\bgradle build\b|跑构建|执行构建|编译一下|build (?:the )?(?:project|app|package))/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    // Dedicated verify tools may already cover typecheck/build via verify_fix.
    if (countBySet(toolCallsByName, VERIFY_TOOLS) > 0) return true;
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i.test(cmd) ||
        /\b(?:cargo|go)\s+build\b/i.test(cmd) ||
        /\bmake\s+build\b/i.test(cmd) ||
        /\bmvn\s+(?:package|install)\b/i.test(cmd) ||
        /\bgradle(?:w)?\s+build\b/i.test(cmd) ||
        /\btsc\b/i.test(cmd)
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to build/compile the project, and tools have already run without a build-shaped command ' +
    '(`npm run build` / `cargo build` / `tsc` / `verify_fix` / `code_diagnostics`). ' +
    'Run a real build/typecheck and report the output — do not invent "build succeeded".',
});
