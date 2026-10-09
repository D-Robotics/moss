import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../core/tools/tool-types.js';
import { errorMessage } from '../errors.js';
import { ProcessError, runProcess } from '../utils/run-process.js';
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

function view(verdict: 'pass' | 'fail' | 'unknown', result: TestResult, text: string) {
  return { verdict, result, text };
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

function parsePytest(output: string, result: TestResult): boolean {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/test result:/i.test(line) || !/\bin\s+[\d.]+s\b/.test(line)) continue;
    if (!/\b(?:passed|failed|errors?|skipped|no tests ran)\b/i.test(line)) continue;
    const next = blank(output);
    if (!/no tests ran/i.test(line)) {
      const errors = labeled(line, 'errors?');
      next.passed = labeled(line, 'passed');
      next.failed = labeled(line, 'failed') + errors;
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
  return /\[no test files\]/.test(output) ? take(result, next) : false;
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

async function detectPytest(root: string): Promise<boolean> {
  for (const name of ['pytest.ini', 'pytest.toml', 'conftest.py']) {
    if (pathExists(path.join(root, name))) return true;
  }
  for (const name of ['pyproject.toml', 'setup.cfg', 'tox.ini']) {
    if (/pytest/i.test((await readText(path.join(root, name))) ?? '')) return true;
  }
  for (const dir of [root, path.join(root, 'tests'), path.join(root, 'test')]) {
    const names = await fs.readdir(dir).then(
      (value) => value,
      () => [] as string[]
    );
    if (names.some((name) => /^test_.+\.py$/.test(name) || /^.+_test\.py$/.test(name))) return true;
  }
  return false;
}

const RUNNERS: readonly Runner[] = [
  { cmd: () => `${pyBin()} -m pytest`, detect: detectPytest, emptyNone: true, parse: parsePytest },
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

export async function planTestRunners(root: string): Promise<PlannedTestRun> {
  const run: string[] = [];
  let make: string | null = null;
  for (const row of RUNNERS) {
    if (!(await row.detect(root))) continue;
    const command = row.cmd();
    if (row.alone) make = command;
    else run.push(command);
  }
  if (make && run.length === 0) return { run: [make], skipped: [] };
  return { run, skipped: make ? [make] : [] };
}

function matchOutput(
  command: string,
  output: string
): { emptyNone: boolean; result: TestResult } | null {
  const result = blank(output);
  const trimmed = command.trim();
  const hit = (parse: Runner['parse'], emptyNone = false) =>
    parse(output, result) ? { emptyNone, result } : null;
  if (/\bpytest\b/.test(trimmed)) return hit(parsePytest, true);
  if (/\bgo\s+test\b/.test(trimmed)) return hit(parseGo, true);
  if (/\bcargo\s+test\b/.test(trimmed)) return hit(parseCargo, true);
  if (/^npm\b/.test(trimmed)) return hit(parseNpm);
  return hit(parsePytest, true) ?? hit(parseNpm) ?? hit(parseGo, true) ?? hit(parseCargo, true);
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
  const matched = matchOutput(command, output);
  if (!matched) {
    if (exitCode === 0 && !timedOut) {
      return view(
        'unknown',
        blank(output),
        `Test Results:\nCommand: ${command}\nexit 0, counts unknown\ntests_pass=false`
      );
    }
    const why = timedOut ? 'timed out' : (spawnError ?? `exit ${exitCode}`);
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
    const output = failed
      ? `${failed.stdout}\n${failed.stderr}`.trim() || errorMessage(err)
      : errorMessage(err);
    return judge(
      command,
      failed?.exitCode ?? 1,
      output,
      failed?.timedOut === true,
      errorMessage(err)
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
  const note = [
    plan.skipped.length > 0 ? `skipped: ${plan.skipped.join(', ')}` : '',
    held.length > 0 ? `not run (timeout budget): ${held.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const failed = held.length > 0 || views.some((view) => view.verdict === 'fail');
  const unknown = !failed && views.some((view) => view.verdict === 'unknown');
  const passed = views.length > 0 && !failed && views.every((view) => view.verdict === 'pass');
  const noTests =
    !unknown &&
    held.length === 0 &&
    views.length > 0 &&
    views.every(
      (view) => view.text.includes('\nno tests\n') || view.text.includes('NO TESTS EXECUTED')
    );
  const blocks = [...views.map((view) => view.text), note].filter(Boolean);
  const text =
    views.length === 1 && note.length === 0
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
    notRun: views.length === 0 && held.length > 0,
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
    'No pytest, go test, cargo test, make test, or npm test target was found.',
    "Use the exec tool with the project's own test command.",
  ].join('\n');
}

async function planFromInput(
  ctx: ToolContext,
  input: Record<string, unknown> | undefined,
  source: 'run' | 'verify'
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
        return {
          commands: [`${bin} -m pytest ${fileRaw}`],
          skipped: [],
          env,
          direct: { cmd: bin, args: ['-m', 'pytest', abs] },
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
  const detected = await planTestRunners(ctx.workspaceDir);
  if (detected.run.length === 0) {
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
  const plan = await planFromInput(ctx, input, 'run');
  if (!isRunPlan(plan)) return 'message' in plan ? plan.message : noRunnerMessage();
  return (await executePlan(ctx, plan, timeoutMs)).text;
}

export async function runVerifyTests(
  ctx: ToolContext,
  input: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<SuiteOutcome> {
  const plan = await planFromInput(ctx, input, 'verify');
  if (!isRunPlan(plan)) return skippedOutcome();
  return executePlan(ctx, plan, timeoutMs);
}
