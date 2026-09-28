/**
 * ContractVisualToolsNudge — mid-run reminder when the user asked for contract
 * or visual-regression tests but no matching exec (or run_tests/verify_fix)
 * has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedContractVisualCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const CONTRACT_VISUAL_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type ContractVisualToolsNudgeRequest = NudgeRequest;
export type ContractVisualToolsNudgeResult = NudgeResult;

export const evaluateContractVisualToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bcontract tests?\b|\bvisual(?: regression)? tests?\b|\bpact\b|\bschemathesis\b|\bchromatic\b|\bpercy\b|\bloki\b|契约测试|视觉回归)/iu,
  actionRe: /(?:run|please|now|帮我|请|现在|跑)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    if ((toolCallsByName.run_tests ?? 0) > 0 || (toolCallsByName.verify_fix ?? 0) > 0) return true;
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\bpact\b/i.test(cmd) ||
        /\bschemathesis\b/i.test(cmd) ||
        /\bdredd\b/i.test(cmd) ||
        /\bchromatic\b/i.test(cmd) ||
        /\bpercy\b/i.test(cmd) ||
        /\bloki\b/i.test(cmd) ||
        /\bbackstop\b/i.test(cmd) ||
        /\bnpm run (?:test:)?(?:contract|visual|chromatic)\b|\bpnpm (?:run )?(?:test:)?(?:contract|visual|chromatic)\b|\byarn (?:test:)?(?:contract|visual|chromatic)\b/i.test(
          cmd
        )
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked for contract or visual-regression tests, and tools have already run without a matching command ' +
    '(`pact`, `schemathesis`, `chromatic`, `percy`, `npm run test:contract`, etc.) or `run_tests`/`verify_fix`. ' +
    'Run the real suite and report its output, or clearly say it was not run. ' +
    'Do not invent contract/visual results.',
});
