/**
 * CodegenToolsNudge — mid-run reminder when the user asked to generate
 * clients/types but no codegen-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCodegenCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const CODEGEN_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type CodegenToolsNudgeRequest = NudgeRequest;
export type CodegenToolsNudgeResult = NudgeResult;

export const evaluateCodegenToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bprisma generate\b|\bgraphql-codegen\b|\bopenapi[- ]?generator\b|\bbuf generate\b|\bprotoc\b|\bgenerate (?:the )?(?:types|client|SDK|protobuf)\b|\bnpm run (?:codegen|generate)\b|生成类型|生成 client|跑 codegen)/iu,
  actionRe: /(?:please|now|go ahead|run it|execute|帮我|请|现在)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\bprisma\s+generate\b/i.test(cmd) ||
        /\bgraphql-codegen\b/i.test(cmd) ||
        /\bopenapi-generator\b/i.test(cmd) ||
        /\bbuf\s+generate\b/i.test(cmd) ||
        /\bprotoc\b/i.test(cmd) ||
        /\bnpm run (?:codegen|generate)\b|\bpnpm (?:run )?(?:codegen|generate)\b|\byarn (?:codegen|generate)\b/i.test(
          cmd
        )
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to generate clients/types (prisma generate / graphql-codegen / openapi / protobuf), ' +
    'and tools have already run without a matching generate command. ' +
    'Run the real codegen via `exec` and report its output, or clearly say generation was skipped. ' +
    'Do not invent generated clients/types.',
});
