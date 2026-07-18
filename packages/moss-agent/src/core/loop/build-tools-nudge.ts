/**
 * BuildToolsNudge — mid-run reminder when the user asked to build/compile
 * but no build-shaped verification exec has run yet.
 *
 * Soft: max 1 fire. Complements invented-verification gate (build-succeeded claims)
 * and RunTestsToolsNudge (explicit test asks).
 */

export const BUILD_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

const BUILD_USER_RE =
  /(?:\bnpm run build\b|\bpnpm (?:run )?build\b|\byarn build\b|\bbun run build\b|\bcargo build\b|\bgo build\b|\bmake build\b|\bmvn (?:package|install)\b|\bgradle build\b|跑构建|执行构建|编译一下|build (?:the )?(?:project|app|package))/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface BuildToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type BuildToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function collectExecCommands(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): string[] {
  if (!messages?.length) return [];
  const out: string[] = [];
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || !b.name || !EXEC_TOOLS.has(b.name)) continue;
      const input = b.input;
      if (!input || typeof input !== 'object') continue;
      const o = input as Record<string, unknown>;
      for (const key of ['command', 'cmd', 'input'] as const) {
        if (typeof o[key] === 'string' && String(o[key]).trim()) {
          out.push(String(o[key]));
          break;
        }
      }
    }
  }
  return out;
}

function sawBuildShapedExec(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): boolean {
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
}

function countBySet(byName: Record<string, number>, names: Set<string>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

export function evaluateBuildToolsNudge(request: BuildToolsNudgeRequest): BuildToolsNudgeResult {
  if (request.attempts >= BUILD_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };

  // Dedicated verify tools may already cover typecheck/build via verify_fix.
  if (countBySet(request.toolCallsByName, VERIFY_TOOLS) > 0) return { fire: false };
  if (sawBuildShapedExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !BUILD_USER_RE.test(user)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to build/compile the project, and tools have already run without a build-shaped command ' +
      '(`npm run build` / `cargo build` / `tsc` / `verify_fix` / `code_diagnostics`). ' +
      'Run a real build/typecheck and report the output — do not invent "build succeeded".',
  };
}
