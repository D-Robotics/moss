/**
 * CodegenToolsNudge — mid-run reminder when the user asked to generate
 * clients/types but no codegen-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCodegenCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const CODEGEN_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const CODEGEN_USER_RE =
  /(?:\bprisma generate\b|\bgraphql-codegen\b|\bopenapi[- ]?generator\b|\bbuf generate\b|\bprotoc\b|\bgenerate (?:the )?(?:types|client|SDK|protobuf)\b|\bnpm run (?:codegen|generate)\b|生成类型|生成 client|跑 codegen)/iu;

const CODEGEN_ACTION_RE = /(?:please|now|go ahead|run it|execute|帮我|请|现在)/iu;

export type CodegenToolsNudgeRequest = NudgeRequest;
export type CodegenToolsNudgeResult = NudgeResult;

function sawCodegenExec(messages: NudgeMessage[] | undefined): boolean {
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\bprisma\s+generate\b/i.test(cmd) ||
      /\bgraphql-codegen\b/i.test(cmd) ||
      /\bopenapi-generator\b/i.test(cmd) ||
      /\bbuf\s+generate\b/i.test(cmd) ||
      /\bprotoc\b/i.test(cmd) ||
      /\bnpm run (?:codegen|generate)\b|\bpnpm (?:run )?(?:codegen|generate)\b|\byarn (?:codegen|generate)\b/i.test(
        cmd,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateCodegenToolsNudge(
  request: CodegenToolsNudgeRequest,
): CodegenToolsNudgeResult {
  if (request.attempts >= CODEGEN_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawCodegenExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !CODEGEN_USER_RE.test(user)) return { fire: false };

  // Conceptual "what is prisma generate?" — avoid bare \bgenerate\b matching the topic word.
  if (isConceptualQuestion(user, CODEGEN_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to generate clients/types (prisma generate / graphql-codegen / openapi / protobuf), ' +
      'and tools have already run without a matching generate command. ' +
      'Run the real codegen via `exec` and report its output, or clearly say generation was skipped. ' +
      'Do not invent generated clients/types.',
  };
}
