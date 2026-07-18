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
import { runProcess } from '../utils/run-process.js';
import { errorMessage } from '../errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 120_000;

export interface TestResult {
  testFiles?: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: Array<{ name: string; message: string }>;
  rawOutput: string;
}

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
  durationMs: number;
}

// ── run_tests tool ──────────────────────────────────────────────────────────

export const runTestsTool: Tool = {
  name: 'run_tests',
  description:
    'Run the project test suite and return structured results (pass/fail counts, ' +
    'failing test names + messages). Use this instead of `exec` for running tests — ' +
    'the structured output lets you identify exactly which tests failed and why, ' +
    'without parsing raw terminal output. Supports npm test, node --test, or a ' +
    'custom command. Defaults to `npm test` in the workspace.',
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
        description: 'Test command to run. Default: "npm test".',
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout in ms (default ${DEFAULT_TEST_TIMEOUT_MS}).`,
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    const command = String(input?.command || 'npm test').trim();
    const timeoutMs = Math.max(5000, Number(input?.timeout_ms) || DEFAULT_TEST_TIMEOUT_MS);
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    try {
      const result = await runProcess(shell, {
        args,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
        env: { ...process.env } as Record<string, string>,
        cwd: ctx.workspaceDir,
      });
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      const parsed = parseTestOutput(output);

      return formatTestResult(parsed, command);
    } catch (err) {
      // ProcessError on non-zero exit — normal for test failures.
      const errAny = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number };
      const output = `${errAny.stdout || ''}\n${errAny.stderr || ''}`.trim() || errorMessage(err);
      const parsed = parseTestOutput(output);

      if (parsed.failed > 0 || parsed.total > 0) {
        return formatTestResult(parsed, command);
      }
      return `Test command failed to run: ${errorMessage(err)}\n\nOutput:\n${output.slice(0, 2000)}`;
    }
  },
};

// ── verify_fix tool ─────────────────────────────────────────────────────────

export const verifyFixTool: Tool = {
  name: 'verify_fix',
  description:
    'Run build + typecheck + tests in one call. Use this after making code changes ' +
    'to verify the fix is correct: does the project build? Does tsc pass? Do all ' +
    'tests pass? Returns a structured summary. If any step fails, the output ' +
    'includes the specific error messages so you can fix them.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Runs build, typecheck, and test commands in the workspace.',
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
        description: 'Typecheck command. Default: "npm run typecheck". Set to empty string to skip.',
      },
      test_command: {
        type: 'string',
        description: 'Test command. Default: "npm test". Set to empty string to skip.',
      },
      timeout_ms: {
        type: 'number',
        description: `Per-step timeout in ms (default ${DEFAULT_BUILD_TIMEOUT_MS}).`,
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    const timeoutMs = Math.max(5000, Number(input?.timeout_ms) || DEFAULT_BUILD_TIMEOUT_MS);
    const packageScripts = await readPackageScripts(ctx.workspaceDir);
    const buildCmd = resolveVerifyCommand(input, 'build_command', packageScripts, 'build');
    const typecheckCmd = resolveVerifyCommand(input, 'typecheck_command', packageScripts, 'typecheck');
    const testCmd = resolveVerifyCommand(input, 'test_command', packageScripts, 'test');
    const startedAt = Date.now();
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';

    const result: VerifyResult = {
      buildOk: false,
      typecheckOk: false,
      testsOk: false,
      durationMs: 0,
    };

    // Step 1: Build
    if (buildCmd) {
      try {
        const buildResult = await runCommand(shell, buildCmd, timeoutMs, ctx);
        result.buildOk = buildResult.exitCode === 0;
        result.buildOutput = buildResult.output.slice(0, 4000);
      } catch (err) {
        result.buildOutput = errorMessage(err).slice(0, 4000);
      }
    } else {
      result.buildOk = true;
      result.buildSkipped = true;
    }

    // Step 2: Typecheck (skip if build failed or command is empty)
    if (result.buildOk && typecheckCmd) {
      try {
        const tcResult = await runCommand(shell, typecheckCmd, timeoutMs, ctx);
        result.typecheckOk = tcResult.exitCode === 0;
        result.typecheckOutput = tcResult.output.slice(0, 4000);
      } catch (err) {
        result.typecheckOutput = errorMessage(err).slice(0, 4000);
      }
    } else if (!typecheckCmd) {
      result.typecheckOk = true; // skipped = pass
      result.typecheckSkipped = true;
    }

    // Step 3: Tests (skip if build or typecheck failed)
    if (result.buildOk && result.typecheckOk && testCmd) {
      try {
        const testResult = await runCommand(shell, testCmd, timeoutMs, ctx);
        const parsed = parseTestOutput(testResult.output);
        result.testResult = parsed;
        // testsOk requires zero failures and evidence of real execution.
        // - failed===0 && passed>0 → green (some may still be skipped)
        // - parsed summary with zero executed (empty or all-skipped) → not green
        // - exit 0 + non-empty output without a parseable summary → soft ok
        //   (truncated runners that drop ℹ lines)
        // - empty stdout+stderr → not green
        const hasSummary =
          /ℹ\s*tests\s+\d+/i.test(testResult.output) ||
          /\[test\]\s+passed\s+\d+\s+file/i.test(testResult.output);
        const noExecuted =
          parsed.failed === 0 &&
          parsed.passed === 0 &&
          (parsed.total === 0 || parsed.skipped >= parsed.total);
        const unparseableCleanExit =
          testResult.exitCode === 0 &&
          parsed.failed === 0 &&
          !hasSummary &&
          testResult.output.trim().length > 0;
        if (parsed.failed > 0) {
          result.testsOk = false;
        } else if (parsed.passed > 0) {
          result.testsOk = true;
        } else if (hasSummary && noExecuted) {
          result.testsOk = false;
        } else if (unparseableCleanExit) {
          result.testsOk = true;
        } else {
          result.testsOk = false;
        }
      } catch (err) {
        const errOutput = (err as { stdout?: string; stderr?: string });
        const output = `${errOutput.stdout || ''}\n${errOutput.stderr || ''}`.trim();
        const parsed = parseTestOutput(output);
        result.testResult = parsed;
        result.testsOk = false;
      }
    } else if (!testCmd) {
      result.testsOk = true; // skipped = not a hard fail for that step
      result.testsSkipped = true;
    }

    result.durationMs = Date.now() - startedAt;
    return formatVerifyResult(result);
  },
};

export const harnessTools: Tool[] = [runTestsTool, verifyFixTool];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readPackageScripts(workspaceDir: string): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.scripts).filter((entry): entry is [string, string] => (
        typeof entry[1] === 'string' && entry[1].trim().length > 0
      )),
    );
  } catch {
    return null;
  }
}

function resolveVerifyCommand(
  input: Record<string, unknown> | undefined,
  field: 'build_command' | 'typecheck_command' | 'test_command',
  packageScripts: Record<string, string> | null,
  script: 'build' | 'typecheck' | 'test',
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
  ctx: ToolContext,
): Promise<{ exitCode: number; output: string }> {
  const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  const result = await runProcess(shell, {
    args,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    signal: ctx.abortSignal,
    env: { ...process.env } as Record<string, string>,
    cwd: ctx.workspaceDir,
  });
  return {
    exitCode: result.exitCode ?? 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
  };
}

function parseTestOutput(output: string): TestResult {
  const result: TestResult = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    failures: [],
    rawOutput: output,
  };

  // Node.js test runner format: "ℹ tests N", "ℹ pass N", "ℹ fail N"
  const sumMatches = (pattern: RegExp): number => {
    let sum = 0;
    for (const match of output.matchAll(pattern)) sum += Number(match[1]) || 0;
    return sum;
  };
  const testsMatches = [...output.matchAll(/ℹ\s*tests\s+(\d+)/g)];
  result.total = testsMatches.reduce((sum, match) => sum + Number(match[1]), 0);
  result.passed = sumMatches(/ℹ\s*pass\s+(\d+)/g);
  result.failed = sumMatches(/ℹ\s*fail\s+(\d+)/g);
  result.skipped = sumMatches(/ℹ\s*skipped\s+(\d+)/g);
  result.durationMs = sumMatches(/ℹ\s*duration_ms\s+([\d.]+)/g);

  // Also match "passed N file(s)" (moss's own test runner)
  const fileMatch = output.match(/\[test\]\s+passed\s+(\d+)\s+file/);
  if (fileMatch) {
    result.testFiles = parseInt(fileMatch[1], 10);
    if (testsMatches.length === 0) {
      result.total = result.testFiles;
      result.passed = result.testFiles;
      result.failed = 0;
    }
  }

  // Infer total if the ℹ tests summary line was missing (e.g. output
  // truncated by timeout). total = passed + failed + skipped. This prevents
  // verify_fix from reporting false FAIL when the summary is absent.
  // (Found by moss self-iteration — the total>0 gate caused false negatives.)
  if (result.total === 0 && (result.passed > 0 || result.failed > 0 || result.skipped > 0)) {
    result.total = result.passed + result.failed + result.skipped;
  }

  // Extract individual failures: "✖ test name" or "not ok N - test name"
  // The AssertionError regex previously captured the file path after "at " as
  // the name — semantically wrong (name should identify the test, not the
  // stack frame) and produced duplicate entries (Node prints both ✖ and
  // AssertionError for the same failure; dedup keys on name+message so the
  // two different names don't merge). Fixed to capture the assertion message
  // text instead, which is useful even without a ✖ line. (Found by moss
  // self-iteration — glm-5.2 reviewed this file.)
  const failureRegexes = [
    /✖\s+(.+?)(?:\n|$)/g,
    /not ok\s+\d+\s+-\s+(.+?)(?:\n|$)/g,
    /AssertionError[:\s]*([^\n]+)/g,
  ];
  for (const re of failureRegexes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const name = m[1].trim().slice(0, 200);
      // Get a short error message from nearby lines
      const lineStart = Math.max(0, m.index - 200);
      const lineEnd = Math.min(output.length, m.index + 500);
      const context = output.slice(lineStart, lineEnd);
      const msgMatch = context.match(/(?:AssertionError|Error)[:\s]*(.+?)(?:\n|$)/);
      result.failures.push({
        name,
        message: msgMatch ? msgMatch[1].trim().slice(0, 300) : '',
      });
    }
  }

  // Deduplicate failures
  const seen = new Set<string>();
  result.failures = result.failures.filter((f) => {
    const key = f.name + f.message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return result;
}

/**
 * Compact failure lines for TUI collapsed tool rows (edit→verify UX).
 * Returns [] when the result is green / not a verification tool body.
 */
export function extractVerificationFailurePreview(
  toolName: string,
  resultText: string,
  maxLines = 4,
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
export function summarizeVerificationResult(
  toolName: string,
  resultText: string,
): string | null {
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
      /Tests:\s*(\d+)\s*total,\s*(\d+)\s*passed,\s*(\d+)\s*failed(?:,\s*(\d+)\s*skipped)?/i,
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
          : `${passed}/${total} passed` + (skipped && Number(skipped) > 0 ? ` · ${skipped} skipped` : ''),
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
      s ? s.replace(/[❌✅⏭]/gu, '').replace(/\s+/g, ' ').trim() : '';
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
    const first = text.split('\n').map((l) => l.trim()).find(Boolean);
    if (first) return first.length > 56 ? `${first.slice(0, 55)}…` : first;
  }

  return null;
}

function formatTestResult(result: TestResult, command: string): string {
  // Zero executed tests is not green evidence (empty suite / all skipped / parse miss).
  const noExecuted =
    result.failed === 0 && result.passed === 0 && (result.total === 0 || result.skipped >= result.total);
  const status =
    result.failed > 0
      ? `❌ ${result.failed} FAILED`
      : noExecuted
        ? '⚠️ NO TESTS EXECUTED'
        : '✅ ALL PASSED';
  let output = `Test Results: ${status}\n`;
  output += `Command: ${command}\n`;
  if (result.testFiles !== undefined) output += `Test files: ${result.testFiles} passed\n`;
  output += `Tests: ${result.total} total, ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped\n`;
  output += `Duration: ${result.durationMs}ms\n`;

  if (result.failures.length > 0) {
    output += `\nFailures:\n`;
    for (const f of result.failures.slice(0, 20)) {
      output += `  • ${f.name}`;
      if (f.message) output += ` — ${f.message}`;
      output += '\n';
    }
    if (result.failures.length > 20) {
      output += `  ... and ${result.failures.length - 20} more\n`;
    }
  }

  if (result.failed > 0 && result.rawOutput.trim()) {
    output += `\nFailure output:\n${result.rawOutput.trim().slice(-4000)}\n`;
  }

  if (result.failed > 0) {
    output +=
      '\nNext step: fix the failing tests (minimal surgical edits), then re-run `run_tests` or `verify_fix`. ' +
      'Do not report done while tests are red.\n';
  } else if (noExecuted) {
    output +=
      '\nNext step: no tests actually ran (empty suite, all skipped, or unparsed output). ' +
      'Run a real suite or pass an explicit command — do not treat this as green verification.\n';
  }

  return output;
}

function formatVerifyResult(result: VerifyResult): string {
  const steps: string[] = [];
  steps.push(`Build: ${result.buildSkipped ? '⏭ skipped' : result.buildOk ? '✅ pass' : '❌ FAIL'}`);
  steps.push(`Typecheck: ${result.typecheckSkipped ? '⏭ skipped' : result.typecheckOk ? '✅ pass' : '❌ FAIL'}`);
  steps.push(`Tests: ${result.testsSkipped ? '⏭ skipped' : result.testsOk ? '✅ pass' : '❌ FAIL'}`);

  const anyStepRan =
    !result.buildSkipped || !result.typecheckSkipped || !result.testsSkipped;
  const allSkipped =
    Boolean(result.buildSkipped) &&
    Boolean(result.typecheckSkipped) &&
    Boolean(result.testsSkipped);
  // Prefer the testsOk flag (which already encodes empty/all-skipped). Only fall
  // back to raw testResult totals when testsOk is false for empty-suite messaging.
  const testsEmpty =
    !result.testsSkipped &&
    !result.testsOk &&
    result.testResult &&
    result.testResult.failed === 0 &&
    result.testResult.passed === 0 &&
    (result.testResult.total === 0 ||
      result.testResult.skipped >= result.testResult.total);

  // ALL PASSED only when at least one step actually ran and none failed.
  // All-skipped / empty suite is not green evidence.
  const allOk =
    anyStepRan &&
    !allSkipped &&
    result.buildOk &&
    result.typecheckOk &&
    result.testsOk;

  let statusLine: string;
  if (allOk) statusLine = '✅ ALL PASSED';
  else if (allSkipped) statusLine = '⚠️ NO STEPS EXECUTED';
  else if (testsEmpty && result.buildOk && result.typecheckOk) statusLine = '⚠️ NO TESTS EXECUTED';
  else statusLine = '❌ ISSUES FOUND';

  let output = `Verify Fix: ${statusLine}\n`;
  output += steps.join(' | ') + '\n';
  output += `Duration: ${result.durationMs}ms\n`;

  if (!result.buildOk && result.buildOutput) {
    output += `\n--- Build Errors ---\n${result.buildOutput.slice(0, 2000)}\n`;
  }
  if (!result.typecheckOk && result.typecheckOutput) {
    output += `\n--- Typecheck Errors ---\n${result.typecheckOutput.slice(0, 2000)}\n`;
  }
  if (!result.testsOk && result.testResult) {
    output += `\n--- Test Failures ---\n`;
    output += `Tests: ${result.testResult.total} total, ${result.testResult.passed} passed, ${result.testResult.failed} failed\n`;
    for (const f of result.testResult.failures.slice(0, 10)) {
      output += `  • ${f.name}`;
      if (f.message) output += ` — ${f.message}`;
      output += '\n';
    }
  }

  if (allSkipped) {
    output +=
      '\nNext step: every verify step was skipped (no build/typecheck/test command). ' +
      'Pass explicit commands or ensure package.json scripts exist — do not treat this as green verification.\n';
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
