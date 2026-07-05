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

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 120_000;

export interface TestResult {
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
    const buildCmd = String(input?.build_command || 'npm run build').trim();
    const typecheckCmd = String(input?.typecheck_command ?? 'npm run typecheck').trim();
    const testCmd = String(input?.test_command ?? 'npm test').trim();
    const startedAt = Date.now();
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';

    const result: VerifyResult = {
      buildOk: false,
      typecheckOk: false,
      testsOk: false,
      durationMs: 0,
    };

    // Step 1: Build
    try {
      const buildResult = await runCommand(shell, buildCmd, timeoutMs, ctx);
      result.buildOk = buildResult.exitCode === 0;
      result.buildOutput = buildResult.output.slice(0, 4000);
    } catch (err) {
      result.buildOutput = errorMessage(err).slice(0, 4000);
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
    }

    // Step 3: Tests (skip if build or typecheck failed)
    if (result.buildOk && result.typecheckOk && testCmd) {
      try {
        const testResult = await runCommand(shell, testCmd, timeoutMs, ctx);
        const parsed = parseTestOutput(testResult.output);
        result.testResult = parsed;
        // testsOk: no failures AND either (a) we parsed a total count > 0,
        // or (b) the command exited 0 with no parseable failures (output may
        // have been truncated by timeout, missing the ℹ summary lines).
        // The previous `parsed.total > 0` gate caused false FAIL when the
        // ℹ tests line was absent (found by moss self-iteration).
        result.testsOk = parsed.failed === 0 && (parsed.total > 0 || testResult.exitCode === 0);
      } catch (err) {
        const errOutput = (err as { stdout?: string; stderr?: string });
        const output = `${errOutput.stdout || ''}\n${errOutput.stderr || ''}`.trim();
        const parsed = parseTestOutput(output);
        result.testResult = parsed;
        result.testsOk = false;
      }
    } else if (!testCmd) {
      result.testsOk = true; // skipped = pass
    }

    result.durationMs = Date.now() - startedAt;
    return formatVerifyResult(result);
  },
};

export const harnessTools: Tool[] = [runTestsTool, verifyFixTool];

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  const testsMatch = output.match(/ℹ\s*tests\s+(\d+)/);
  const passMatch = output.match(/ℹ\s*pass\s+(\d+)/);
  const failMatch = output.match(/ℹ\s*fail\s+(\d+)/);
  const skipMatch = output.match(/ℹ\s*skipped\s+(\d+)/);

  if (testsMatch) result.total = parseInt(testsMatch[1], 10);
  if (passMatch) result.passed = parseInt(passMatch[1], 10);
  if (failMatch) result.failed = parseInt(failMatch[1], 10);
  if (skipMatch) result.skipped = parseInt(skipMatch[1], 10);

  // Also match "passed N file(s)" (moss's own test runner)
  if (!testsMatch) {
    const fileMatch = output.match(/\[test\]\s+passed\s+(\d+)\s+file/);
    if (fileMatch) {
      result.total = parseInt(fileMatch[1], 10);
      result.passed = parseInt(fileMatch[1], 10);
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

function formatTestResult(result: TestResult, command: string): string {
  const status = result.failed === 0 ? '✅ ALL PASSED' : `❌ ${result.failed} FAILED`;
  let output = `Test Results: ${status}\n`;
  output += `Command: ${command}\n`;
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

  return output;
}

function formatVerifyResult(result: VerifyResult): string {
  const steps: string[] = [];
  steps.push(`Build: ${result.buildOk ? '✅ pass' : '❌ FAIL'}`);
  steps.push(`Typecheck: ${result.typecheckOk ? '✅ pass' : '❌ FAIL'}`);
  steps.push(`Tests: ${result.testsOk ? '✅ pass' : '❌ FAIL'}`);

  const allOk = result.buildOk && result.typecheckOk && result.testsOk;
  let output = `Verify Fix: ${allOk ? '✅ ALL PASSED' : '❌ ISSUES FOUND'}\n`;
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

  return output;
}
