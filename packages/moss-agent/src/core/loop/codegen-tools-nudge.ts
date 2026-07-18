/**
 * CodegenToolsNudge — mid-run reminder when the user asked to generate
 * clients/types but no codegen-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCodegenCompletionGate.
 */

export const CODEGEN_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const CODEGEN_USER_RE =
  /(?:\bprisma generate\b|\bgraphql-codegen\b|\bopenapi[- ]?generator\b|\bbuf generate\b|\bprotoc\b|\bgenerate (?:the )?(?:types|client|SDK|protobuf)\b|\bnpm run (?:codegen|generate)\b|生成类型|生成 client|跑 codegen)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface CodegenToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type CodegenToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawCodegenExec(
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
  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:please|now|go ahead|run it|execute|帮我|请|现在)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked to generate clients/types (prisma generate / graphql-codegen / openapi / protobuf), ' +
      'and tools have already run without a matching generate command. ' +
      'Run the real codegen via `exec` and report its output, or clearly say generation was skipped. ' +
      'Do not invent generated clients/types.',
  };
}
