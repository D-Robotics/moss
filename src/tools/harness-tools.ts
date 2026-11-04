/**
 * Harness tools — engineering-strength tools for self-iteration.
 *
 * These give the agent first-class code engineering capabilities:
 * - `run_tests`: run the test suite, parse results, identify failures
 *
 * Unlike raw `exec` (which just runs a shell command), these return STRUCTURED
 * output the LLM can act on: pass/fail counts, failure messages, specific
 * failing test names, build errors with file:line.
 *
 * @public
 */
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { runWorkspaceTests } from './test-runners.js';
import { recordHarnessSuiteEvidence } from '../core/task/suite-evidence.js';

const DEFAULT_TEST_TIMEOUT_MS = 120_000;

// ── run_tests tool ──────────────────────────────────────────────────────────

export const runTestsTool: Tool = {
  name: 'run_tests',
  description:
    'Run one test file or one explicit test command and return pass/fail counts. Pass file for the spec you changed. A call with no file and no command does not start the suite. Pass suite=true only when the user asked for the whole suite or you are delivering.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Runs a test command in the workspace. The command is restricted to the workspace cwd.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'One explicit test command. Ignored when `file` is set. Omit this and `file` only together with suite=true.',
      },
      suite: {
        type: 'boolean',
        description:
          'Run the detected full suite (pytest, npm test, go test, cargo test, or make test). Development calls leave this false.',
      },
      file: {
        type: 'string',
        description:
          'Run one file instead of the full suite. Python files use pytest when it ' +
          'is installed, otherwise unittest for unittest modules; other ' +
          'files use `node --test`. Path is relative to the workspace and must stay ' +
          'inside it. When set, `command` is ignored.',
      },
      timeout_ms: {
        type: 'number',
        description: `Total budget in ms for this call. Values below 5000 are raised to 5000 (default ${DEFAULT_TEST_TIMEOUT_MS}).`,
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    // Floor is 5s so a caller cannot set a budget shorter than one scheduler slice.
    const timeoutMs = Math.max(5000, Number(input?.timeout_ms) || DEFAULT_TEST_TIMEOUT_MS);
    const text = await runWorkspaceTests(ctx, input, timeoutMs);
    const testsPassed = suitePassedFlag(text);
    if (testsPassed !== undefined) {
      await recordHarnessSuiteEvidence({
        workspaceDir: ctx.workspaceDir,
        taskTurn: ctx.goalExecWait === true,
        source: 'run_tests',
        testsPassed,
        output: text,
      });
    }
    return text;
  },
};

function suitePassedFlag(text: string): boolean | undefined {
  const overall = text.match(/overall tests_pass=(true|false)/);
  if (overall) return overall[1] === 'true';
  if (text.includes('tests_pass=true') && !text.includes('tests_pass=false')) return true;
  if (text.includes('tests_pass=false')) return false;
  return undefined;
}

export const harnessTools: Tool[] = [runTestsTool];

// ── Helpers ─────────────────────────────────────────────────────────────────

export function extractVerificationFailurePreview(
  toolName: string,
  resultText: string,
  maxLines = 4
): string[] {
  const text = String(resultText ?? '');
  if (!text.trim()) return [];
  if (toolName !== 'run_tests' && !/^Test Results:/m.test(text)) return [];

  // Green / no-op: no preview needed (summary already on the headline).
  if (/Test Results:\s*✅/i.test(text)) return [];

  const lines: string[] = [];
  // Structured failure bullets from formatTestResult
  for (const m of text.matchAll(/^\s*[•*]\s+(.+)$/gm)) {
    const line = (m[1] ?? '').trim();
    if (line) lines.push(line.length > 96 ? `${line.slice(0, 95)}…` : line);
    if (lines.length >= maxLines) return lines;
  }

  // Typecheck/build error sections — take first non-empty error-ish lines
  const section = text.match(/---\s*(?:Build|Typecheck|Test)[^-\n]*---\s*([\s\S]*?)(?:\n---|$)/i);
  if (section?.[1]) {
    for (const raw of section[1].split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^Tests?:\s*\d+/i.test(line)) continue;
      lines.push(line.length > 96 ? `${line.slice(0, 95)}…` : line);
      if (lines.length >= maxLines) return lines;
    }
  }

  return lines.slice(0, maxLines);
}

/**
 * One-line summary for TUI/CLI tool rows so edit→verify feedback is visible
 * without expanding the full tool result (coding-first UX).
 */
export function summarizeVerificationResult(toolName: string, resultText: string): string | null {
  const text = String(resultText ?? '').trim();
  if (!text) return null;
  if (toolName !== 'run_tests' && !/^Test Results:/m.test(text)) return null;

  const status =
    text.match(/Test Results:\s*([^\n]+)/)?.[1]?.trim() ??
    (text.includes('FAILED')
      ? 'FAILED'
      : text.includes('ALL PASSED')
        ? 'ALL PASSED'
        : text.includes('NO TESTS EXECUTED')
          ? 'NO TESTS EXECUTED'
          : null);
  const counts = text.match(
    /Tests:\s*(\d+)\s*total,\s*(\d+)\s*passed,\s*(\d+)\s*failed(?:,\s*(\d+)\s*skipped)?/i
  );
  const firstFailure = text.match(/^\s*[•*]\s+(.+)$/m)?.[1]?.trim();
  const parts: string[] = [];
  if (status) parts.push(status.replace(/(?:❌|✅|⚠️)/gu, '').trim());
  if (counts) {
    const total = counts[1];
    const passed = counts[2];
    const failed = counts[3];
    const skipped = counts[4];
    parts.push(
      Number(failed) > 0
        ? `${failed} failed / ${total}`
        : `${passed}/${total} passed` +
            (skipped && Number(skipped) > 0 ? ` · ${skipped} skipped` : '')
    );
  }
  if (firstFailure && Number(counts?.[3] ?? 0) > 0) {
    parts.push(firstFailure.length > 42 ? `${firstFailure.slice(0, 41)}…` : firstFailure);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
