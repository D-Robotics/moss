import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../core/tools/tool-types.js';
import { errorMessage } from '../errors.js';
import { ProcessError, runProcess } from '../utils/run-process.js';
import {
  UNITTEST_IMPORT,
  pythonTestLayout,
  unittestDiscoverArgs,
} from '../utils/python-test-layout.js';
import { pathExists } from '../utils/workspace-paths.js';

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

export interface PlannedTestRun {
  run: string[];
  skipped: string[];
}

interface SuiteOutcome {
  text: string;
  passed: boolean;
  unknown: boolean;
  noTests: boolean;
  skipped: boolean;
  notRun: boolean;
  note: string;
  result: TestResult;
}

interface Runner {
  cmd: () => string;
  detect: (root: string) => boolean | Promise<boolean>;
  /** Zero passed and zero failed is `no tests`, not an unknown exit 0. */
  emptyNone?: boolean;
  alone?: boolean;
  parse: (output: string, result: TestResult) => boolean;
}

interface DirectSpawn {
  cmd: string;
  args: string[];
}

interface RunPlan {
  commands: string[];
  skipped: string[];
  env: Record<string, string>;
  direct: DirectSpawn | null;
}

type Plan = { message: string } | { skip: true } | RunPlan;

const pyBin = (): string => (process.platform === 'win32' ? 'python' : 'python3');

const childEnv = (): Record<string, string> => ({ ...process.env }) as Record<string, string>;

function readText(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').then(
    (value) => value,
    () => null
  );
}

export async function readPackageScripts(
  workspaceDir: string
): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.scripts).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].trim().length > 0
      )
    );
  } catch {
    return null;
  }
}

function blank(output: string): TestResult {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    failures: [],
    rawOutput: output,
  };
}

function view(
  verdict: 'pass' | 'fail' | 'unknown' | 'notRun',
  result: TestResult,
  text: string,
  hint = ''
) {
  return { verdict, result, text, hint };
}

const labeled = (line: string, label: string): number =>
  Number(line.match(new RegExp(`(\\d+)\\s+${label}\\b`, 'i'))?.[1] ?? 0);

function sumMatches(output: string, pattern: RegExp): number {
  let sum = 0;
  for (const match of output.matchAll(pattern)) sum += Number(match[1]) || 0;
  return sum;
}

const take = (result: TestResult, next: TestResult): boolean => {
  next.rawOutput = result.rawOutput;
  Object.assign(result, next);
  return true;
};

function noExecuted(result: TestResult): boolean {
  return (
    result.failed === 0 &&
    result.passed === 0 &&
    (result.total === 0 || result.skipped >= result.total)
  );
}

function parseNode(output: string, result: TestResult): boolean {
  const tests = [...output.matchAll(/(?:ℹ|#)\s*tests\s+(\d+)/g)];
  const next = blank(output);
  next.passed = sumMatches(output, /(?:ℹ|#)\s*pass\s+(\d+)/g);
  next.failed = sumMatches(output, /(?:ℹ|#)\s*fail\s+(\d+)/g);
  next.skipped = sumMatches(output, /(?:ℹ|#)\s*skipped\s+(\d+)/g);
  next.durationMs = sumMatches(output, /(?:ℹ|#)\s*duration_ms\s+([\d.]+)/g);
  next.total = tests.reduce((sum, match) => sum + Number(match[1]), 0);
  const files = output.match(/\[test\]\s+passed\s+(\d+)\s+file/);
  if (tests.length === 0 && !files && next.passed === 0 && next.failed === 0) return false;
  if (files) {
    next.testFiles = parseInt(files[1] ?? '0', 10);
    if (tests.length === 0) {
      next.total = next.testFiles;
      next.passed = next.testFiles;
      next.failed = 0;
    }
  }
  if (next.total === 0 && (next.passed > 0 || next.failed > 0 || next.skipped > 0)) {
    next.total = next.passed + next.failed + next.skipped;
  }
  collectFailures(output, next);
  return take(result, next);
}

const JS_LINES: ReadonlyArray<{ re: RegExp; paren: boolean }> = [
  { re: /^Tests:\s+(.+)$/gim, paren: false },
  { re: /^\s*Tests\s{2,}(.+)$/gim, paren: true },
];

function parseJs(output: string, result: TestResult): boolean {
  const next = blank(output);
  for (const row of JS_LINES) {
    row.re.lastIndex = 0;
    const hit = [...output.matchAll(row.re)].find((match) =>
      row.paren ? /\(\d+\)/.test(match[1] ?? '') : /total/i.test(match[1] ?? '')
    );
    if (!hit) continue;
    const line = hit[1] ?? '';
    next.failed = labeled(line, 'failed');
    next.passed = labeled(line, 'passed');
    next.skipped = labeled(line, 'skipped') + labeled(line, 'pending') + labeled(line, 'todo');
    const paren = line.match(/\((\d+)\)/);
    next.total =
      row.paren && paren
        ? Number(paren[1])
        : labeled(line, 'total') || next.passed + next.failed + next.skipped;
    return take(result, next);
  }
  const passing = output.match(/(\d+)\s+passing\b/);
  const failing = output.match(/(\d+)\s+failing\b/);
  if (!passing && !failing) return false;
  next.passed = passing ? Number(passing[1]) : 0;
  next.failed = failing ? Number(failing[1]) : 0;
  next.total = next.passed + next.failed;
  return take(result, next);
}

const parseNpm = (output: string, result: TestResult): boolean =>
  parseNode(output, result) || parseJs(output, result);

function parseUnittest(output: string, result: TestResult): boolean {
  const ran = output.match(/Ran (\d+) tests? in ([\d.]+)s/);
  if (!ran) return false;
  const next = blank(output);
  next.total = Number(ran[1]);
  next.durationMs = Math.round(Number(ran[2]) * 1000);
  const failedLine = output.match(/FAILED \(([^)]+)\)/);
  const okLine = output.match(/^OK(?:\s+\(([^)]+)\))?$/m);
  if (failedLine) {
    const body = failedLine[1] ?? '';
    const count = (label: string): number =>
      Number(new RegExp(`${label}=(\\d+)`).exec(body)?.[1] ?? 0);
    next.skipped = count('skipped');
    const rawFailed = count('failures') + count('errors') + count('unexpected successes');
    const room = Math.max(0, next.total - next.skipped);
    next.failed = Math.min(rawFailed, room);
    next.passed = room - next.failed;
  } else if (okLine) {
    next.skipped = Number(okLine[1]?.match(/skipped=(\d+)/)?.[1] ?? 0);
    next.passed = Math.max(0, next.total - next.skipped);
    next.failed = 0;
  } else if (/NO TESTS RAN/i.test(output)) {
    next.passed = 0;
    next.failed = 0;
  } else {
    return false;
  }
  for (const match of output.matchAll(/^(?:FAIL|ERROR|UNEXPECTED SUCCESS):\s+(.+)$/gm)) {
    const name = (match[1] ?? '').trim().slice(0, 200);
    if (name) next.failures.push({ name, message: 'failed' });
  }
  return take(result, next);
}

function parsePytest(output: string, result: TestResult): boolean {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/test result:/i.test(line) || !/\bin\s+[\d.]+s\b/.test(line)) continue;
    if (!/\b(?:xfailed|xpassed|passed|failed|errors?|skipped|no tests ran)\b/i.test(line)) continue;
    const next = blank(output);
    if (!/no tests ran/i.test(line)) {
      const errors = labeled(line, 'errors?');
      next.passed = labeled(line, 'passed') + labeled(line, 'xfailed');
      next.failed = labeled(line, 'failed') + errors + labeled(line, 'xpassed');
      next.skipped = labeled(line, 'skipped');
      next.total = next.passed + next.failed + next.skipped;
      const duration = line.match(/\bin\s+([\d.]+)s\b/);
      if (duration) next.durationMs = Math.round(Number(duration[1]) * 1000);
    }
    return take(result, next);
  }
  return false;
}

function parseGo(output: string, result: TestResult): boolean {
  const next = blank(output);
  const failedPkg = new Set<string>();
  let saw = false;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { Action?: unknown; Test?: unknown; Package?: unknown };
    try {
      event = JSON.parse(trimmed) as { Action?: unknown; Test?: unknown; Package?: unknown };
    } catch {
      continue;
    }
    const testName = typeof event.Test === 'string' ? event.Test : '';
    const pkg = typeof event.Package === 'string' ? event.Package : '';
    if (testName) {
      if (event.Action === 'pass') next.passed += 1;
      else if (event.Action === 'fail') next.failed += 1;
      else if (event.Action === 'skip') next.skipped += 1;
      else continue;
      if (event.Action === 'fail' && pkg) failedPkg.add(pkg);
      saw = true;
      continue;
    }
    // Package result follows its tests. Skip when a test in that package already
    // failed; still count a package with no Test (build, TestMain, panic).
    if (event.Action === 'fail' && !(pkg && failedPkg.has(pkg))) {
      next.failed += 1;
      if (pkg) next.failures.push({ name: pkg, message: 'package failed' });
      saw = true;
    }
  }
  if (saw) {
    next.total = next.passed + next.failed + next.skipped;
    return take(result, next);
  }
  return parseGoPlain(output, result);
}

/** `go test` without `-json`: `ok` / `FAIL` package lines, plus `--- FAIL` names. */
function parseGoPlain(output: string, result: TestResult): boolean {
  const next = blank(output);
  const tests: string[] = [];
  let saw = false;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const named = line.match(/^--- FAIL:\s+(\S+)/);
    if (named?.[1]) {
      tests.push(named[1]);
      saw = true;
      continue;
    }
    const pkg = line.match(/^(ok|FAIL)\s+(\S+)/);
    if (!pkg?.[2]) continue;
    saw = true;
    if (pkg[1] === 'ok') next.passed += 1;
    else {
      next.failed += 1;
      next.failures.push({ name: pkg[2], message: 'package failed' });
    }
  }
  if (!saw) return /\[no test files\]/.test(output) ? take(result, next) : false;
  if (next.failed === 0 && tests.length > 0) next.failed = tests.length;
  for (const name of tests) next.failures.push({ name, message: 'failed' });
  next.total = next.passed + next.failed + next.skipped;
  return take(result, next);
}

function parseCargo(output: string, result: TestResult): boolean {
  const matches = [
    ...output.matchAll(/test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/g),
  ];
  if (matches.length === 0) return false;
  const next = blank(output);
  for (const match of matches) {
    next.passed += Number(match[1]);
    next.failed += Number(match[2]);
    next.skipped += Number(match[3]);
  }
  next.total = next.passed + next.failed + next.skipped;
  return take(result, next);
}

function unittestCommand(root: string): string {
  return `${pyBin()} -m unittest discover ${unittestDiscoverArgs(root)}`;
}

function pytestMissing(text: string): boolean {
  return (
    /No module named ['"]?pytest\b/i.test(text) ||
    /\bpytest\b[^\n]{0,48}\b(?:command not found|not found|not recognized)\b/i.test(text) ||
    /\b(?:command not found|not found|not recognized)\b[^\n]{0,48}\bpytest\b/i.test(text)
  );
}

function programName(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? 'command';
  const base = token.split(/[/\\]/).pop() ?? token;
  return base || 'command';
}

/** Name of a runner binary the shell or spawn could not find. */
function missingBinaryName(text: string): string | null {
  const patterns = [
    /(?:^|[\n])[^\n]*?:\s*([A-Za-z0-9_.+-]+):\s*(?:command )?not found\b/,
    /'([A-Za-z0-9_.+-]+)' is not recognized as an internal or external command/i,
    /\bspawn(?:Sync)?\s+([A-Za-z0-9_.+-]+)\s+ENOENT\b/,
  ];
  for (const pattern of patterns) {
    const name = pattern.exec(text)?.[1];
    if (!name || name === 'sh' || name === 'bash' || name === 'dash') continue;
    return name;
  }
  return null;
}

/**
 * Missing runner binaries are not a failed suite. Exit 127, spawn ENOENT, and
 * the Windows "not recognized" line are the same outcome pytest already
 * reports: `not run`, with `<program> not installed`.
 */
function missingRunnerHint(command: string, exitCode: number, text: string): string | null {
  if (/\bpytest\b/.test(command) && pytestMissing(text)) return 'pytest not installed';
  const enoent = /\bspawn(?:Sync)?\s+([A-Za-z0-9_.+-]+)\s+ENOENT\b/.exec(text)?.[1];
  if (enoent) return `${enoent} not installed`;
  const unrecognized =
    /'([A-Za-z0-9_.+-]+)' is not recognized as an internal or external command/i.exec(text)?.[1];
  if (unrecognized) return `${unrecognized} not installed`;
  if (exitCode !== 127) return null;
  return `${missingBinaryName(text) ?? programName(command)} not installed`;
}

function notRunText(command: string, hint: string): string {
  return `Test Results: not run\nCommand: ${command}\n${hint}\ntests_pass=false`;
}

async function exitsZero(
  ctx: ToolContext,
  cmd: string,
  args: string[],
  timeout: number
): Promise<boolean> {
  if (timeout <= 0 || ctx.abortSignal?.aborted) return false;
  try {
    const result = await runProcess(cmd, {
      args,
      timeout,
      signal: ctx.abortSignal,
      env: childEnv(),
      cwd: ctx.workspaceDir,
      maxBuffer: 1024 * 1024,
    });
    return (result.exitCode ?? 1) === 0;
  } catch (err) {
    if (ctx.abortSignal?.aborted) throw err;
    return false;
  }
}

/** `command -v pytest`, then `python -m pytest --version`, inside the call budget. */
async function pytestImportable(ctx: ToolContext, deadline: number): Promise<boolean> {
  const left = (): number => deadline - Date.now();
  const shell = shellOf();
  const which = process.platform === 'win32' ? ['/c', 'where pytest'] : ['-c', 'command -v pytest'];
  if (await exitsZero(ctx, shell, which, Math.min(left(), 1000))) return true;
  if (left() <= 0 || ctx.abortSignal?.aborted) return false;
  return exitsZero(ctx, pyBin(), ['-m', 'pytest', '--version'], Math.min(left(), 1500));
}

const RUNNERS: readonly Runner[] = [
  { cmd: () => `${pyBin()} -m pytest`, detect: () => false, emptyNone: true, parse: parsePytest },
  {
    cmd: () => 'npm test --silent',
    detect: async (root) => Boolean((await readPackageScripts(root))?.test),
    parse: parseNpm,
  },
  {
    cmd: () => 'go test -json ./...',
    detect: (root) => pathExists(path.join(root, 'go.mod')),
    emptyNone: true,
    parse: parseGo,
  },
  {
    cmd: () => 'cargo test',
    detect: (root) => pathExists(path.join(root, 'Cargo.toml')),
    emptyNone: true,
    parse: parseCargo,
  },
  {
    cmd: () => 'make test',
    detect: async (root) => /^test\s*:/m.test((await readText(path.join(root, 'Makefile'))) ?? ''),
    alone: true,
    parse: () => false,
  },
];

export async function planTestRunners(
  root: string,
  confirmLoosePytest?: () => Promise<boolean>
): Promise<PlannedTestRun> {
  const run: string[] = [];
  const skipped: string[] = [];
  const pytestCmd = `${pyBin()} -m pytest`;
  const layout = pythonTestLayout(root);
  if (layout === 'pytest' || layout === 'loose' || layout === 'unittest') {
    const pytestReady =
      layout === 'pytest' || (confirmLoosePytest ? await confirmLoosePytest() : false);
    if (layout === 'pytest' || pytestReady) run.push(pytestCmd);
    else if (layout === 'unittest') run.push(unittestCommand(root));
    else skipped.push(`${pytestCmd} (pytest not installed)`);
  }
  let make: string | null = null;
  for (const row of RUNNERS) {
    if (!(await row.detect(root))) continue;
    const command = row.cmd();
    if (row.alone) make = command;
    else run.push(command);
  }
  if (make && run.length === 0) return { run: [make], skipped };
  if (make) skipped.push(make);
  return { run, skipped };
}

function matchOutput(
  command: string,
  output: string
): { emptyNone: boolean; result: TestResult } | null {
  const result = blank(output);
  const trimmed = command.trim();
  const hit = (parse: Runner['parse'], emptyNone = false) =>
    parse(output, result) ? { emptyNone, result } : null;
  if (/\bunittest\b/.test(trimmed)) return hit(parseUnittest, true);
  if (/\bpytest\b/.test(trimmed)) return hit(parsePytest, true);
  if (/\bgo\s+test\b/.test(trimmed)) return hit(parseGo, true);
  if (/\bcargo\s+test\b/.test(trimmed)) return hit(parseCargo, true);
  if (/^npm\b/.test(trimmed)) return hit(parseNpm);
  return (
    hit(parseUnittest, true) ??
    hit(parsePytest, true) ??
    hit(parseNpm) ??
    hit(parseGo, true) ??
    hit(parseCargo, true)
  );
}

export function formatFailures(failures: TestResult['failures'], limit: number): string {
  if (failures.length === 0) return '';
  let out = '\nFailures:\n';
  for (const failure of failures.slice(0, limit)) {
    out += `  • ${failure.name}`;
    if (failure.message) out += ` — ${failure.message}`;
    out += '\n';
  }
  if (failures.length > limit) out += `  ... and ${failures.length - limit} more\n`;
  return out;
}

function formatCounts(
  result: TestResult,
  command: string,
  pass: boolean,
  timedOut: boolean,
  exitCode: number
): string {
  const empty = noExecuted(result);
  const status = pass
    ? '✅ ALL PASSED'
    : timedOut
      ? '❌ timed out'
      : result.failed > 0
        ? `❌ ${result.failed} FAILED`
        : empty
          ? '⚠️ NO TESTS EXECUTED'
          : `❌ exit ${exitCode}`;
  let output = `Test Results: ${status}\nCommand: ${command}\n`;
  output += `tests_pass=${pass ? 'true' : 'false'}\n`;
  if (result.testFiles !== undefined) output += `Test files: ${result.testFiles} passed\n`;
  output += `Tests: ${result.total} total, ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped\n`;
  output += `Duration: ${result.durationMs}ms\n`;
  output += formatFailures(result.failures, 20);
  if (result.failed > 0 && result.rawOutput.trim()) {
    output += `\nFailure output:\n${result.rawOutput.trim().slice(-4000)}\n`;
  }
  if (!pass && !empty) {
    output +=
      '\nNext step: fix the failing tests (minimal surgical edits), then re-run `run_tests` or `verify_fix`. ' +
      'Do not report done while tests are red.\n';
  } else if (empty && !timedOut) {
    output +=
      '\nNext step: no tests actually ran (empty suite, all skipped, or unparsed output). ' +
      'Run a real suite or pass an explicit command — do not treat this as green verification.\n';
  }
  return output;
}

function judge(
  command: string,
  exitCode: number,
  output: string,
  timedOut = false,
  spawnError?: string
) {
  const blob = `${output}\n${spawnError ?? ''}`;
  if (!timedOut) {
    const hint = missingRunnerHint(command, exitCode, blob);
    const parsed = hint ? matchOutput(command, output) : null;
    if (hint && !parsed) return view('notRun', blank(output), notRunText(command, hint), hint);
  }
  const matched = matchOutput(command, output);
  if (!matched) {
    if (timedOut) {
      const body = output.trim();
      const shown = body ? `\n\nOutput:\n${body.slice(0, 2000)}\n` : '\n';
      return view(
        'fail',
        blank(output),
        `Test Results: ❌ timed out\nCommand: ${command}${shown}tests_pass=false`
      );
    }
    if (exitCode === 0) {
      return view(
        'unknown',
        blank(output),
        `Test Results:\nCommand: ${command}\nexit 0, counts unknown\ntests_pass=false`
      );
    }
    const why = spawnError ?? `exit ${exitCode}`;
    return view(
      'fail',
      blank(output),
      `Test command failed to run: ${why}\n\nOutput:\n${output.slice(0, 2000)}\nCommand: ${command}\ntests_pass=false`
    );
  }
  if (timedOut) {
    return view(
      'fail',
      matched.result,
      formatCounts(matched.result, command, false, true, exitCode)
    );
  }
  if (matched.emptyNone && matched.result.passed === 0 && matched.result.failed === 0) {
    return view(
      'fail',
      matched.result,
      `Test Results:\nCommand: ${command}\nno tests\ntests_pass=false`
    );
  }
  const pass = exitCode === 0 && matched.result.failed === 0 && !noExecuted(matched.result);
  return view(
    pass ? 'pass' : 'fail',
    matched.result,
    formatCounts(matched.result, command, pass, false, exitCode)
  );
}

export function renderCommandResult(
  command: string,
  exitCode: number,
  output: string,
  timedOut = false
): string {
  return judge(command, exitCode, output, timedOut).text;
}

function collectFailures(output: string, result: TestResult): void {
  const seen = new Set<string>();
  const patterns = [/✖\s+(.+)/g, /not ok\s+\d+\s+-\s+(.+)/g, /AssertionError[:\s]*([^\n]+)/g];
  for (const re of patterns) {
    for (const match of output.matchAll(re)) {
      const name = (match[1] ?? '').trim().slice(0, 200);
      const at = match.index ?? 0;
      const context = output.slice(Math.max(0, at - 200), at + 500);
      const message = (context.match(/(?:AssertionError|Error)[:\s]*(.+)/)?.[1] ?? '')
        .trim()
        .slice(0, 300);
      const key = name + message;
      if (seen.has(key)) continue;
      seen.add(key);
      result.failures.push({ name, message });
    }
  }
}

const shellOf = (): string =>
  process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';

async function spawnOne(
  ctx: ToolContext,
  command: string,
  timeoutMs: number,
  env: Record<string, string>,
  direct: DirectSpawn | null
) {
  const args = direct
    ? direct.args
    : process.platform === 'win32'
      ? ['/c', command]
      : ['-c', command];
  try {
    const result = await runProcess(direct ? direct.cmd : shellOf(), {
      args,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      signal: ctx.abortSignal,
      env,
      cwd: ctx.workspaceDir,
    });
    return judge(
      command,
      result.exitCode ?? 0,
      `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    );
  } catch (err) {
    const failed = err instanceof ProcessError ? err : null;
    const timedOut = failed?.timedOut === true;
    const raw = failed ? `${failed.stdout}\n${failed.stderr}`.trim() : '';
    return judge(
      command,
      failed?.exitCode ?? 1,
      timedOut ? raw : raw || errorMessage(err),
      timedOut,
      timedOut ? undefined : errorMessage(err)
    );
  }
}

const skippedOutcome = (): SuiteOutcome => ({
  text: '',
  passed: false,
  unknown: false,
  noTests: false,
  skipped: true,
  notRun: false,
  note: '',
  result: blank(''),
});

async function executePlan(
  ctx: ToolContext,
  plan: RunPlan,
  timeoutMs: number
): Promise<SuiteOutcome> {
  const deadline = Date.now() + timeoutMs;
  const views: Array<ReturnType<typeof judge>> = [];
  const held: string[] = [];
  for (let i = 0; i < plan.commands.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      held.push(...plan.commands.slice(i));
      break;
    }
    views.push(
      await spawnOne(ctx, plan.commands[i] ?? '', remaining, plan.env, i === 0 ? plan.direct : null)
    );
  }
  const displayNote = [
    plan.skipped.length > 0 ? `skipped: ${plan.skipped.join(', ')}` : '',
    held.length > 0 ? `not run (timeout budget): ${held.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const actionable = views.filter((view) => view.verdict !== 'notRun');
  const failed = held.length > 0 || actionable.some((view) => view.verdict === 'fail');
  const unknown = !failed && actionable.some((view) => view.verdict === 'unknown');
  const passed =
    actionable.length > 0 && !failed && actionable.every((view) => view.verdict === 'pass');
  const notRunViews = views.filter((view) => view.verdict === 'notRun');
  const installNotes = [...new Set(notRunViews.map((view) => view.hint).filter(Boolean))];
  const note = [displayNote, ...installNotes].filter(Boolean).join('\n');
  const noTests =
    !unknown &&
    notRunViews.length === 0 &&
    held.length === 0 &&
    views.length > 0 &&
    views.every(
      (view) => view.text.includes('\nno tests\n') || view.text.includes('NO TESTS EXECUTED')
    );
  const blocks = [...views.map((view) => view.text), displayNote].filter(Boolean);
  const text =
    views.length === 1 && displayNote.length === 0
      ? (views[0]?.text ?? '')
      : `${blocks.join('\n\n')}\n\noverall tests_pass=${passed}`;
  const result = blank('');
  for (const view of views) {
    result.total += view.result.total;
    result.passed += view.result.passed;
    result.failed += view.result.failed;
    result.skipped += view.result.skipped;
    result.durationMs += view.result.durationMs;
    result.failures.push(...view.result.failures);
    if (view.result.rawOutput) result.rawOutput += `${view.result.rawOutput}\n`;
    if (view.result.testFiles !== undefined) {
      result.testFiles = (result.testFiles ?? 0) + view.result.testFiles;
    }
  }
  return {
    text,
    passed,
    unknown,
    noTests,
    skipped: false,
    notRun:
      (views.length === 0 && held.length > 0) ||
      (!failed &&
        actionable.length === 0 &&
        (notRunViews.length > 0 ||
          plan.skipped.some((line) => line.includes('pytest not installed')))),
    note,
    result,
  };
}

function explicitField(
  input: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  if (!input || !Object.prototype.hasOwnProperty.call(input, field)) return undefined;
  return String(input[field] ?? '').trim();
}

function noRunnerMessage(): string {
  return [
    'Test Results: no runner detected',
    'tests_pass=false',
    'No pytest, unittest, go test, cargo test, make test, or npm test target was found.',
    "Use the exec tool with the project's own test command.",
  ].join('\n');
}

async function planFromInput(
  ctx: ToolContext,
  input: Record<string, unknown> | undefined,
  source: 'run' | 'verify',
  deadline: number
): Promise<Plan> {
  const env = childEnv();
  if (source === 'verify') {
    const explicit = explicitField(input, 'test_command');
    if (explicit === '') return { skip: true };
    if (explicit) return { commands: [explicit], skipped: [], env, direct: null };
  } else {
    const fileRaw = input?.file ? String(input.file).trim() : '';
    if (fileRaw) {
      const root = path.resolve(ctx.workspaceDir);
      const abs = path.resolve(root, fileRaw);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return { message: `Test file path escapes workspace: ${fileRaw}` };
      }
      // Direct spawn avoids shell quoting. node --test must not inherit its IPC env.
      if (fileRaw.endsWith('.py')) {
        const bin = pyBin();
        const pytestOk = await pytestImportable(ctx, deadline);
        const source = pytestOk ? null : await readText(abs);
        const flag = !pytestOk && source && UNITTEST_IMPORT.test(source) ? 'unittest' : 'pytest';
        return {
          commands: [`${bin} -m ${flag} ${fileRaw}`],
          skipped: [],
          env,
          direct: { cmd: bin, args: ['-m', flag, fileRaw] },
        };
      }
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;
      return {
        commands: [`node --test ${fileRaw}`],
        skipped: [],
        env,
        direct: { cmd: process.execPath, args: ['--test', abs] },
      };
    }
    if (input?.command) {
      return { commands: [String(input.command).trim()], skipped: [], env, direct: null };
    }
  }
  const detected = await planTestRunners(ctx.workspaceDir, () => pytestImportable(ctx, deadline));
  if (detected.run.length === 0) {
    if (detected.skipped.some((line) => line.includes('pytest not installed'))) {
      return { commands: [], skipped: detected.skipped, env, direct: null };
    }
    return source === 'verify' ? { skip: true } : { message: noRunnerMessage() };
  }
  return { commands: detected.run, skipped: detected.skipped, env, direct: null };
}

const isRunPlan = (plan: Plan): plan is RunPlan => 'commands' in plan;

export async function runWorkspaceTests(
  ctx: ToolContext,
  input: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const plan = await planFromInput(ctx, input, 'run', deadline);
  if (!isRunPlan(plan)) return 'message' in plan ? plan.message : noRunnerMessage();
  return (await executePlan(ctx, plan, Math.max(0, deadline - Date.now()))).text;
}

export async function runVerifyTests(
  ctx: ToolContext,
  input: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<SuiteOutcome> {
  const deadline = Date.now() + timeoutMs;
  const plan = await planFromInput(ctx, input, 'verify', deadline);
  if (!isRunPlan(plan)) return skippedOutcome();
  return executePlan(ctx, plan, Math.max(0, deadline - Date.now()));
}
