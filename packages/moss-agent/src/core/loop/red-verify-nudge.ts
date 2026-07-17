/**
 * RedVerifyNudge — mid-run recovery after a red verification result.
 *
 * VerifyNudge intentionally skips once any verify tool was *called*, so a failed
 * `run_tests` / `verify_fix` / `code_diagnostics` (or verification-shaped exec)
 * would silence mid-run pressure and leave the model free to keep editing blind
 * until the end-of-turn completion gate. This nudge fires once when the latest
 * verification-class tool_result is red / is_error, forcing fix-then-rerun.
 *
 * Soft: max 1 fire per agent run; never blocks completion.
 */
import type { Message } from '../session/session-jsonl.js';

const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);
const EXEC_TOOLS = new Set(['exec', 'exec_background']);

const VERIFY_COMMAND_RE =
  /(?:\b(?:test|tests|verify|typecheck|lint|build|jest|vitest|pytest|mocha)\b|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|npm\s+run\s+(?:test|verify|check|lint|build|typecheck)|pnpm\s+run\s+(?:test|verify|check|lint|build|typecheck)|yarn\s+(?:test|run\s+(?:test|verify|check|lint|build|typecheck))|\bnpx\s+tsc\b|\btsc\b)/i;

const RED_RESULT_RE =
  /Test Results:\s*❌|Verify Fix:\s*❌|❌\s+\d+\s+FAILED|❌\s+ISSUES FOUND|\bResult:\s*FAIL\b|Command failed\b|^\s*exit_code:\s*[1-9]/im;

/** Max fires per red wave; after a green verify, the counter may reset. */
export const RED_VERIFY_NUDGE_MAX_ATTEMPTS = 2;

export interface RedVerifyNudgeRequest {
  messages: Message[];
  attempts: number;
}

export type RedVerifyNudgeResult =
  | { fire: false; /** When latest verify is green, host should reset attempts. */ resetAttempts?: boolean }
  | { fire: true; correction: string; toolName: string; resetAttempts?: boolean };

function toolResultText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { type?: string; content?: unknown; text?: string };
  if (b.type !== 'tool_result') return '';
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return b.content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && typeof (c as { text?: string }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  }
  if (typeof b.text === 'string') return b.text;
  return '';
}

function toolUseNameById(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; id?: string; name?: string };
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        map.set(b.id, b.name);
      }
    }
  }
  return map;
}

function execCommandByUseId(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || typeof b.id !== 'string' || !b.name || !EXEC_TOOLS.has(b.name)) {
        continue;
      }
      const input = b.input;
      let cmd = '';
      if (input && typeof input === 'object') {
        const o = input as Record<string, unknown>;
        for (const key of ['command', 'cmd', 'input'] as const) {
          if (typeof o[key] === 'string' && String(o[key]).trim()) {
            cmd = String(o[key]);
            break;
          }
        }
      }
      if (cmd) map.set(b.id, cmd);
    }
  }
  return map;
}

interface VerifyResultHit {
  name: string;
  text: string;
  isError: boolean;
  isVerification: boolean;
}

function collectVerifyResults(messages: Message[]): VerifyResultHit[] {
  const nameById = toolUseNameById(messages);
  const execById = execCommandByUseId(messages);
  const out: VerifyResultHit[] = [];

  for (const m of messages) {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as {
        type?: string;
        name?: string;
        tool_name?: string;
        toolName?: string;
        tool_use_id?: string;
        toolCallId?: string;
        outcome?: string;
        is_error?: boolean;
        isError?: boolean;
      };
      if (!b || b.type !== 'tool_result') continue;
      const useId = b.tool_use_id ?? b.toolCallId ?? '';
      const name =
        b.name ?? b.tool_name ?? b.toolName ?? (useId ? nameById.get(useId) : undefined) ?? '';
      const text = toolResultText(b);
      const flaggedError =
        b.is_error === true ||
        b.isError === true ||
        b.outcome === 'error' ||
        b.outcome === 'blocked' ||
        b.outcome === 'denied';

      let isVerification = VERIFY_TOOLS.has(name);
      if (!isVerification && EXEC_TOOLS.has(name)) {
        const cmd = useId ? execById.get(useId) : undefined;
        isVerification = Boolean(cmd && VERIFY_COMMAND_RE.test(cmd));
      }
      if (!isVerification) continue;

      out.push({
        name: name || 'unknown',
        text,
        isError: flaggedError,
        isVerification: true,
      });
    }
  }
  return out;
}

function isRed(hit: VerifyResultHit): boolean {
  if (hit.isError) return true;
  if (!hit.text.trim()) return false;
  // Green banners win
  if (/Test Results:\s*✅|Verify Fix:\s*✅|Result:\s*PASS\b/i.test(hit.text) && !/❌/.test(hit.text)) {
    return false;
  }
  return RED_RESULT_RE.test(hit.text);
}

/**
 * Mid-run nudge when the latest verification-class result is red.
 * Green latest result → `resetAttempts` so a later red wave can fire again.
 */
export function evaluateRedVerifyNudge(request: RedVerifyNudgeRequest): RedVerifyNudgeResult {
  const results = collectVerifyResults(request.messages);
  if (results.length === 0) return { fire: false };

  const latest = results[results.length - 1]!;
  if (!isRed(latest)) {
    // Latest verification is green — allow future red waves to nudge again.
    return { fire: false, resetAttempts: request.attempts > 0 };
  }

  if (request.attempts >= RED_VERIFY_NUDGE_MAX_ATTEMPTS) return { fire: false };

  const preview = latest.text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, 4)
    .join('\n');

  return {
    fire: true,
    toolName: latest.name,
    correction:
      `[System] The latest verification result is RED (${latest.name}). Do not keep editing blindly.\n` +
      `Excerpt:\n${preview}\n` +
      'Fix the reported failures with minimal surgical edits, then re-run the same verification tool. ' +
      'Only continue other work after verification is green (or you have an explicit blocker to report).',
  };
}
