/**
 * Harness tools — engineering-strength tools for self-iteration.
 *
 * These give the agent first-class code engineering capabilities:
 * - `run_tests`: run the test suite, parse results, identify failures
 * - `verify_fix`: run build + typecheck + tests in one call
 *
 * Unlike raw `exec` (which just runs a shell command), these return STRUCTURED
 * output the LLM can act on: pass/fail counts, failure messages, specific
 * failing test names, build errors with file:line.
 *
 * @public
 */
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { ProcessError, runProcess } from '../utils/run-process.js';
import { errorMessage } from '../errors.js';
import {
  formatFailures,
  readPackageScripts,
  runVerifyTests,
  runWorkspaceTests,
} from './test-runners.js';
import type { TestResult } from './test-runners.js';

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 120_000;

export interface VerifyResult {
  buildOk: boolean;
  typecheckOk: boolean;
  testsOk: boolean;
  buildSkipped?: boolean;
  typecheckSkipped?: boolean;
  testsSkipped?: boolean;
  buildOutput?: string;
  typecheckOutput?: string;
  testResult?: TestResult;
  testsUnknown?: boolean;
  testsNoTests?: boolean;
  buildNotRun?: boolean;
  typecheckNotRun?: boolean;
  testsNotRun?: boolean;
  testNote?: string;
  durationMs: number;
}

// ── run_tests tool ──────────────────────────────────────────────────────────

export const runTestsTool: Tool = {
  name: 'run_tests',
  description:
    'Run tests and return structured pass/fail counts and failing names. With no command, detect pytest, go test, cargo test, npm test, or make test. Pass file to run one spec (Python under pytest, otherwise node --test). Prefer file while iterating on a single spec.',
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
          'Test command to run. When omitted, the workspace runner is detected ' +
          '(pytest, go test, cargo test, make test, or npm test). Ignored when `file` is set.',
      },
      file: {
        type: 'string',
        description:
          'Run one file instead of the full suite. Python files use pytest; other ' +
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
    return runWorkspaceTests(ctx, input, timeoutMs);
  },
};

// ── verify_fix tool ─────────────────────────────────────────────────────────

export const verifyFixTool: Tool = {
  name: 'verify_fix',
  description:
    'Run build, typecheck, and tests in one call and return a structured summary. Failures include the error text.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary: 'Runs build, typecheck, and test commands in the workspace.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      build_command: {
        type: 'string',
        description: 'Build command. Default: "npm run build".',
      },
      typecheck_command: {
        type: 'string',
        description:
          'Typecheck command. Default: "npm run typecheck". Set to empty string to skip.',
      },
      test_command: {
        type: 'string',
        description:
          'Test command. When omitted, the same runner detection as run_tests. Set to empty string to skip.',
      },
      timeout_ms: {
        type: 'number',
        description: `Total budget in ms for build, typecheck, and tests. Values below 5000 are raised to 5000 (default ${DEFAULT_BUILD_TIMEOUT_MS}).`,
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    // Same 5s floor as run_tests. The value is one budget for every step below.
    const timeoutMs = Math.max(5000, Number(input?.timeout_ms) || DEFAULT_BUILD_TIMEOUT_MS);
    const packageScripts = await readPackageScripts(ctx.workspaceDir);
    const buildCmd = resolveVerifyCommand(input, 'build_command', packageScripts, 'build');
    const typecheckCmd = resolveVerifyCommand(
      input,
      'typecheck_command',
      packageScripts,
      'typecheck'
    );
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const shell = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const left = (): number => Math.max(0, deadline - Date.now());

    const result: VerifyResult = {
      buildOk: false,
      typecheckOk: false,
      testsOk: false,
      durationMs: 0,
    };
    // A started step that hits the deadline holds every step after it.
    let budgetHeld = false;
    const heldByTimeout = (err: unknown): boolean => {
      if (!(err instanceof ProcessError) || !err.timedOut) return false;
      budgetHeld = true;
      return true;
    };

    // timeout_ms is one budget for build, typecheck, and every test runner.
    if (buildCmd) {
      const budget = left();
      if (budget <= 0) {
        result.buildNotRun = true;
        result.buildOutput = 'not run (timeout budget)';
      } else {
        try {
          const buildResult = await runCommand(shell, buildCmd, budget, ctx);
          result.buildOk = buildResult.exitCode === 0;
          result.buildOutput = buildResult.output.slice(0, 4000);
        } catch (err) {
          result.buildOutput = errorMessage(err).slice(0, 4000);
          heldByTimeout(err);
        }
      }
    } else {
      result.buildOk = true;
      result.buildSkipped = true;
    }

    // Typecheck (skip if build failed or command is empty). A step the budget
    // never started is `not run`, not a failure.
    if (result.buildNotRun || (budgetHeld && !result.buildOk)) {
      if (typecheckCmd) result.typecheckNotRun = true;
      else {
        result.typecheckOk = true;
        result.typecheckSkipped = true;
      }
    } else if (result.buildOk && typecheckCmd) {
      const budget = left();
      if (budget <= 0) {
        result.typecheckNotRun = true;
        result.typecheckOutput = 'not run (timeout budget)';
      } else {
        try {
          const tcResult = await runCommand(shell, typecheckCmd, budget, ctx);
          result.typecheckOk = tcResult.exitCode === 0;
          result.typecheckOutput = tcResult.output.slice(0, 4000);
        } catch (err) {
          result.typecheckOutput = errorMessage(err).slice(0, 4000);
          heldByTimeout(err);
        }
      }
    } else if (!typecheckCmd) {
      result.typecheckOk = true; // skipped = pass
      result.typecheckSkipped = true;
    }

    const testsHeld =
      result.buildNotRun ||
      result.typecheckNotRun ||
      (budgetHeld && !(result.buildOk && result.typecheckOk));
    if (testsHeld || (result.buildOk && result.typecheckOk && left() <= 0)) {
      result.testsNotRun = true;
    } else if (result.buildOk && result.typecheckOk) {
      const tests = await runVerifyTests(ctx, input, left());
      if (tests.skipped) {
        result.testsOk = true;
        result.testsSkipped = true;
      } else if (tests.notRun) {
        result.testsNotRun = true;
        result.testNote = tests.note;
      } else {
        result.testsOk = tests.passed;
        result.testsUnknown = tests.unknown;
        result.testsNoTests = tests.noTests;
        result.testNote = tests.note;
        result.testResult = tests.result;
      }
    }

    result.durationMs = Date.now() - startedAt;
    return formatVerifyResult(result);
  },
};

export const harnessTools: Tool[] = [runTestsTool, verifyFixTool];

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveVerifyCommand(
  input: Record<string, unknown> | undefined,
  field: 'build_command' | 'typecheck_command' | 'test_command',
  packageScripts: Record<string, string> | null,
  script: 'build' | 'typecheck' | 'test'
): string {
  if (input && Object.prototype.hasOwnProperty.call(input, field)) {
    return String(input[field] ?? '').trim();
  }
  if (packageScripts === null) {
    return script === 'test' ? 'npm test' : `npm run ${script}`;
  }
  return packageScripts[script] ? (script === 'test' ? 'npm test' : `npm run ${script}`) : '';
}

async function runCommand(
  shell: string,
  command: string,
  timeoutMs: number,
  ctx: ToolContext
): Promise<{ exitCode: number; output: string }> {
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
  const result = await runProcess(shell, {
    args,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    signal: ctx.abortSignal,
    env: { ...process.env } as Record<string, string>,
    cwd: ctx.workspaceDir,
    windowsVerbatimArguments: process.platform === 'win32',
  });
  return {
    exitCode: result.exitCode ?? 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
  };
}

/**
 * Compact failure lines for TUI collapsed tool rows (edit→verify UX).
 * Returns [] when the result is green / not a verification tool body.
 */
export function extractVerificationFailurePreview(
  toolName: string,
  resultText: string,
  maxLines = 4
): string[] {
  const text = String(resultText ?? '');
  if (!text.trim()) return [];
  const isVerify =
    toolName === 'run_tests' ||
    toolName === 'verify_fix' ||
    toolName === 'code_diagnostics' ||
    /^Test Results:/m.test(text) ||
    /^Verify Fix:/m.test(text);
  if (!isVerify) return [];

  // Green / no-op: no preview needed (summary already on the headline).
  if (
    /Test Results:\s*✅/i.test(text) ||
    /Verify Fix:\s*✅/i.test(text) ||
    (/No diagnostics found/i.test(text) && !/Result:\s*FAIL/i.test(text))
  ) {
    return [];
  }

  const lines: string[] = [];
  // Structured failure bullets from formatTestResult / formatVerifyResult
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

  // code_diagnostics / generic: first error-looking lines after status
  if (lines.length === 0) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(?:Test Results|Verify Fix|Command|Duration|Tests:|Result:)/i.test(line)) continue;
      if (/error TS|Error:|FAIL|error\b|✘|✖/i.test(line) || /:\d+:\d+/.test(line)) {
        lines.push(line.length > 96 ? `${line.slice(0, 95)}…` : line);
        if (lines.length >= maxLines) break;
      }
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

  if (toolName === 'run_tests' || /^Test Results:/m.test(text)) {
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

  if (toolName === 'verify_fix' || /^Verify Fix:/m.test(text)) {
    const status =
      text.match(/Verify Fix:\s*([^\n]+)/)?.[1]?.trim() ??
      (text.includes('ISSUES FOUND')
        ? 'ISSUES FOUND'
        : text.includes('ALL PASSED')
          ? 'ALL PASSED'
          : null);
    const build = text.match(/Build:\s*([^\n|]+)/)?.[1]?.trim();
    const typecheck = text.match(/Typecheck:\s*([^\n|]+)/)?.[1]?.trim();
    const tests = text.match(/Tests:\s*([^\n|]+)/)?.[1]?.trim();
    const clean = (s?: string) =>
      s
        ? s
            .replace(/[❌✅⏭]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
        : '';
    const steps = [
      build ? `build ${clean(build)}` : '',
      typecheck ? `tsc ${clean(typecheck)}` : '',
      tests ? `tests ${clean(tests)}` : '',
    ].filter(Boolean);
    const parts: string[] = [];
    if (status) parts.push(status.replace(/(?:❌|✅|⚠️)/gu, '').trim());
    if (steps.length) parts.push(steps.join(' · '));
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  if (toolName === 'code_diagnostics') {
    // Prefer structured diagnostics headers when present.
    const issues = text.match(/(\d+)\s+(?:error|errors|issue|issues|diagnostic)/i);
    const clean = text.match(/No (?:issues|diagnostics|errors)|clean|0 errors/i);
    if (clean && !/error|fail/i.test(text.slice(0, 200))) return 'clean';
    if (issues) return `${issues[1]} issue(s)`;
    const first = text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    if (first) return first.length > 56 ? `${first.slice(0, 55)}…` : first;
  }

  return null;
}

function stepMark(skipped: boolean | undefined, notRun: boolean | undefined, ok: boolean): string {
  if (skipped) return '⏭ skipped';
  if (notRun) return 'not run';
  return ok ? '✅ pass' : '❌ FAIL';
}

function hardFail(ok: boolean, skipped?: boolean, notRun?: boolean): boolean {
  return !ok && !skipped && !notRun;
}

function formatVerifyResult(result: VerifyResult): string {
  const steps = [
    `Build: ${stepMark(result.buildSkipped, result.buildNotRun, result.buildOk)}`,
    `Typecheck: ${stepMark(result.typecheckSkipped, result.typecheckNotRun, result.typecheckOk)}`,
    `Tests: ${
      result.testsSkipped
        ? '⏭ skipped'
        : result.testsNotRun
          ? 'not run'
          : result.testsUnknown
            ? 'exit 0, counts unknown'
            : result.testsOk
              ? '✅ pass'
              : '❌ FAIL'
    }`,
  ];

  const anyStepRan = !result.buildSkipped || !result.typecheckSkipped || !result.testsSkipped;
  const allSkipped =
    Boolean(result.buildSkipped) &&
    Boolean(result.typecheckSkipped) &&
    Boolean(result.testsSkipped);
  const testsEmpty = Boolean(result.testsNoTests);
  const countsUnknown = Boolean(result.testsUnknown) && result.buildOk && result.typecheckOk;
  const budgetHold =
    Boolean(result.buildNotRun || result.typecheckNotRun || result.testsNotRun) &&
    !hardFail(result.buildOk, result.buildSkipped, result.buildNotRun) &&
    !hardFail(result.typecheckOk, result.typecheckSkipped, result.typecheckNotRun) &&
    !hardFail(result.testsOk, result.testsSkipped, result.testsNotRun);

  // ALL PASSED only when a step ran and tests reported real passing counts.
  // Unknown counts are not a failure and not a pass. Held steps are not red.
  const allOk = anyStepRan && !allSkipped && result.buildOk && result.typecheckOk && result.testsOk;

  let statusLine: string;
  if (allOk) statusLine = '✅ ALL PASSED';
  else if (allSkipped) statusLine = '⚠️ NO STEPS EXECUTED';
  else if (countsUnknown) statusLine = 'exit 0, counts unknown';
  else if (testsEmpty && result.buildOk && result.typecheckOk) statusLine = '⚠️ NO TESTS EXECUTED';
  else if (budgetHold) {
    statusLine = result.testNote?.includes('timeout budget')
      ? 'not run (timeout budget)'
      : 'not run';
  } else statusLine = '❌ ISSUES FOUND';

  let output = `Verify Fix: ${statusLine}\n`;
  output += steps.join(' | ') + '\n';
  if (result.testNote) output += `${result.testNote}\n`;
  output += `Duration: ${result.durationMs}ms\n`;

  if (!result.buildOk && !result.buildNotRun && result.buildOutput) {
    output += `\n--- Build Errors ---\n${result.buildOutput.slice(0, 2000)}\n`;
  }
  if (!result.typecheckOk && !result.typecheckNotRun && result.typecheckOutput) {
    output += `\n--- Typecheck Errors ---\n${result.typecheckOutput.slice(0, 2000)}\n`;
  }
  if (!result.testsOk && !result.testsUnknown && !result.testsNotRun && result.testResult) {
    output += `\n--- Test Failures ---\n`;
    output += `Tests: ${result.testResult.total} total, ${result.testResult.passed} passed, ${result.testResult.failed} failed\n`;
    output += formatFailures(result.testResult.failures, 10);
  }

  if (allSkipped) {
    output +=
      '\nNext step: every verify step was skipped (no build/typecheck/test command). ' +
      'Pass explicit commands or ensure package.json scripts exist — do not treat this as green verification.\n';
  } else if (countsUnknown || budgetHold) {
    // Exit 0 with no parsed counts, and steps the budget never started, are not red.
  } else if (testsEmpty && result.buildOk && result.typecheckOk) {
    output +=
      '\nNext step: no tests actually ran. Run a real suite or pass test_command — do not treat this as green verification.\n';
  } else if (!allOk) {
    output +=
      '\nNext step: fix the failing build/typecheck/tests, then re-run `verify_fix` (or the failing step). ' +
      'Do not report done while verification is red.\n';
  }

  return output;
}
