/**
 * Coding verification completion gate (CLI host).
 *
 * When the model edits code and reports done without running any verification
 * (run_tests / verify_fix / exec of a test/build command), inject one
 * correction turn so the loop closes — the same discipline Claude Code / Codex
 * apply by default. Soft: only one retry, only on clear coding-change intents.
 */
import type { Message } from '../core/session/session-jsonl.js';

export interface CodingCompletionGateRequest {
  sessionKey: string;
  runId: string;
  turn: number;
  response: string;
  stopReason?: string;
  messages: Message[];
  totalToolCalls: number;
  toolCallsByName: Record<string, number>;
}

export type CodingCompletionGateResult =
  | { ok: true }
  | { ok: false; reason: string; correction?: string; retryLimit?: number };

const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file', 'apply_patch']);
const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

const CODING_CHANGE_RE =
  /(?:fix|bug|implement|refactor|optimi[sz]e|add\s+(?:a\s+)?(?:test|feature)|repair|patch|修改|修复|实现|重构|优化|加(?:一个|个)?测试|写测试)/iu;

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      // Skip system correction messages
      if (m.content.startsWith('[System]')) continue;
      return m.content;
    }
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (text.startsWith('[System]')) continue;
      // tool_result-only user messages are not the original request
      if (!text.trim()) continue;
      return text;
    }
  }
  return '';
}

function countByPrefix(byName: Record<string, number>, names: Set<string>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

/**
 * Soft gate: if the run edited files under a coding-change intent and never
 * called a verification tool, reject once with a correction that forces
 * run_tests / verify_fix / the project's test command.
 */
export function evaluateCodingCompletionGate(
  request: CodingCompletionGateRequest
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits === 0) return { ok: true };

  const verifies = countByPrefix(request.toolCallsByName, VERIFY_TOOLS);
  // exec often runs tests; treat any exec after edits as weak evidence of verification.
  // Still prefer run_tests when available, but don't force a second loop if exec was used.
  const execs = request.toolCallsByName.exec ?? 0;
  if (verifies > 0 || execs > 0) return { ok: true };

  const userText = lastUserText(request.messages);
  if (!userText || !CODING_CHANGE_RE.test(userText)) return { ok: true };

  // Doc-only / config-only edits often use write_file without tests — if the
  // response already admits no tests were run, don't nag.
  if (/\b(?:did not|didn't|no)\s+(?:run\s+)?tests?\b|未运行测试|没有跑测试/iu.test(request.response)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'edited code without verification',
    retryLimit: 1,
    correction:
      '[System] You edited code but did not run verification. Before finishing: ' +
      'call `run_tests` (or `verify_fix`, or `exec` with the project test/build command), ' +
      'see the real output, then report done with that evidence. Do not claim the change works without running it.',
  };
}

/**
 * Compose host completion gates: structured-output is handled inside MossAgent
 * before this runs. Chain coding verification with any additional host gate.
 */
export function createCliCompletionGate(
  extra?: (request: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> | CodingCompletionGateResult
): (request: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> {
  return async (request) => {
    const coding = evaluateCodingCompletionGate(request);
    if (!coding.ok) return coding;
    if (extra) return extra(request);
    return { ok: true };
  };
}
