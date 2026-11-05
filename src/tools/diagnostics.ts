/**
 * D8 code intelligence, first slice: one aggregated, normalized view of the
 * workspace's compiler and linter findings.
 *
 * `exec` can already reach `tsc`/`eslint`, but it returns one undifferentiated
 * blob and the model pays for re-parsing it every turn. This tool runs the
 * workspace's own toolchains once — `tsc --noEmit --pretty false` and
 * `eslint . --format json` — normalizes both into
 * `{file, line, column, severity, code, message, source}`, and renders a
 * compact, sorted, capped list. A repair loop can then re-run it after an edit
 * and see the remaining findings without a second round of grep/exec.
 *
 * Readonly: `--noEmit` writes no JS, eslint runs without `--fix`, and the tools
 * resolve from the workspace (or `MOSS_TSC_PATH` / `MOSS_ESLINT_PATH`) instead
 * of whatever happens to be on PATH. A missing toolchain is reported as
 * actionable text, never thrown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runProcess, ProcessError } from '../utils/run-process.js';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';

export interface DiagnosticsInput {
  /** Only keep findings at or under these files/directories (workspace-relative or absolute). */
  paths?: string[];
  /** Cap on rendered findings (default 50, maximum 500). */
  max?: number;
  /**
   * Which toolchain family to run. Omitted = auto: Node toolchains when a
   * tsconfig/ESLint config exists, else Python pytest when tests are found.
   */
  kind?: 'auto' | 'node' | 'python';
}

export type DiagnosticSource = 'tsc' | 'eslint' | 'pytest';
export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  /** Workspace-relative path (POSIX separators); '' for a project-level tsc error. */
  file: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  /** `TS2322` for tsc, the rule id (or `fatal`) for eslint. */
  code: string;
  message: string;
  source: DiagnosticSource;
}

const DEFAULT_MAX = 50;
const MAX_LIMIT = 500;
const MESSAGE_MAX_CHARS = 300;
const TSC_TIMEOUT_MS = 180_000;
const ESLINT_TIMEOUT_MS = 120_000;

/** `src/a.ts(12,7): error TS2322: …` — tsc with `--pretty false`. */
const TSC_LOCATED_RE = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/;
/** Older/alternate tsc format: `src/a.ts:12:7 - error TS2322: …`. */
const TSC_COLON_RE = /^(.*?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.*)$/;
/** Project-level tsc error with no location: `error TS5083: Cannot read file …`. */
const TSC_GLOBAL_RE = /^(error|warning)\s+(TS\d+):\s*(.*)$/;

const ESLINT_CONFIG_FILES = [
  'eslint.config.mjs',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
] as const;

const TSC_SEGMENTS = ['node_modules', 'typescript', 'bin', 'tsc'] as const;
const ESLINT_SEGMENTS = ['node_modules', 'eslint', 'bin', 'eslint.js'] as const;

interface ResolvedTool {
  path: string;
  /** Run through `process.execPath` (JS file or `#!…node` script); keeps Windows working. */
  viaNode: boolean;
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

const PYTEST_TIMEOUT_MS = 180_000;
/** `--tb=line` failure line: `/abs/test_x.py:5: AssertionError: assert 1 == 2`. */
const PYTEST_TRACEBACK_RE = /^\s*(.+?\.py):(\d+):\s+(.+)$/;
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Files/dirs that would make pytest a meaningful diagnostics source. */
function hasPythonTests(workspaceDir: string): boolean {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workspaceDir, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 2) continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'tests' || name === 'test') return true;
      if (name.endsWith('.py') && (name.startsWith('test_') || name.endsWith('_test.py')))
        return true;
      if (name === 'node_modules' || name === '.git' || name === '.venv' || name === 'venv')
        continue;
      if (name.startsWith('.')) continue;
      const child = path.join(dir, name);
      try {
        if (fs.statSync(child).isDirectory()) stack.push({ dir: child, depth: depth + 1 });
      } catch {
        // unreadable entry: skip
      }
    }
  }
  return false;
}

interface PytestOutcome {
  diagnostics: Diagnostic[];
  ran: boolean;
  failed: number;
  passed: number;
  notes: string[];
}

/**
 * Run `python3 -m pytest -q --tb=line` and normalize its failure lines. Pytest
 * exits 5 when it collected no tests and 2 on a usage/config error; neither is
 * a "findings" list, so they become notes instead of fake diagnostics.
 */
async function runPytest(
  workspaceDir: string,
  ctx: ToolContext,
  filters: readonly string[]
): Promise<PytestOutcome> {
  const notes: string[] = [];
  const args = ['-m', 'pytest', '-q', '--tb=line', '--no-header', '-p', 'no:cacheprovider'];
  if (filters.length > 0) args.push(...filters);
  let result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };
  try {
    const finished = await runProcess(process.env.MOSS_PYTHON_PATH ?? 'python3', {
      args,
      cwd: canonicalWorkspace(workspaceDir),
      timeout: PYTEST_TIMEOUT_MS,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
    result = {
      stdout: finished.stdout,
      stderr: finished.stderr,
      exitCode: finished.exitCode,
      timedOut: false,
    };
  } catch (err) {
    if (err instanceof ProcessError) {
      result = {
        stdout: err.stdout,
        stderr: err.stderr,
        exitCode: err.exitCode,
        timedOut: err.timedOut,
      };
    } else {
      notes.push(
        `pytest: could not start python3 (${err instanceof Error ? err.message : String(err)}).`
      );
      return { diagnostics: [], ran: false, failed: 0, passed: 0, notes };
    }
  }
  const output = `${result.stdout}\n${result.stderr}`.replace(ANSI_RE, '');
  const diagnostics: Diagnostic[] = [];
  const lines = output.split('\n');
  let inFailures = false;
  for (const line of lines) {
    if (/^=+ FAILURES =+/.test(line)) {
      inFailures = true;
      continue;
    }
    if (
      inFailures &&
      /^=+ (?:short test summary info|warnings summary|slowest|ERRORS)/.test(line)
    ) {
      inFailures = false;
      continue;
    }
    if (!inFailures) continue;
    const match = PYTEST_TRACEBACK_RE.exec(line);
    if (!match) continue;
    const rawFile = match[1];
    const codeMatch = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Warning)?)/.exec(match[3]);
    // `--tb=line` shows a bare `assert ...` for plain assertions; normalize it
    // to the exception pytest would name in its short summary.
    const code = codeMatch?.[1] === 'assert' ? 'AssertionError' : (codeMatch?.[1] ?? 'pytest');
    diagnostics.push({
      file: normalizeFile(rawFile, workspaceDir),
      line: Number(match[2]),
      column: 1,
      severity: 'error',
      code,
      message: capMessage(match[3].trim()),
      source: 'pytest',
    });
  }
  // pytest only prints counts in its summary line, not a machine format.
  const summary = lines
    .slice(-25)
    .reverse()
    .find((line) => /\d+ (?:passed|failed)\b.*\bin \d/.test(line));
  const failed = Number(/(\d+) failed/.exec(summary ?? '')?.[1] ?? diagnostics.length);
  const passed = Number(/(\d+) passed/.exec(summary ?? '')?.[1] ?? 0);
  if (result.timedOut) {
    notes.push('pytest: timed out; raise the budget or narrow paths.');
  } else if (diagnostics.length === 0) {
    if (result.exitCode === 5) {
      notes.push('pytest: collected no tests (exit 5) — nothing to check.');
    } else if ((result.exitCode ?? 0) !== 0) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout);
      notes.push(
        `pytest: exited ${result.exitCode ?? 'unknown'} without parseable failures${detail ? ` — ${detail}` : ''}.`
      );
    }
  }
  return { diagnostics, ran: true, failed, passed, notes };
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * macOS `TMPDIR` is a symlink (`/var` → `/private/var`) and `runProcess`
 * canonicalizes the child's cwd, so a toolchain can report absolute file paths
 * under the real path while ctx.workspaceDir still has the symlink. Compare and
 * relativize against the canonical root, or eslint findings look external.
 */
function canonicalWorkspace(workspaceDir: string): string {
  try {
    return fs.realpathSync(workspaceDir);
  } catch {
    return workspaceDir;
  }
}

/** Walk up from `start` to the filesystem root; undefined when no candidate exists. */
function findUp(start: string, segments: readonly string[]): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ...segments);
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isNodeScript(filePath: string): boolean {
  if (/\.(?:c|m)?js$/.test(filePath)) return true;
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 160);
    return /^#!.*\bnode\b/.test(head);
  } catch {
    return false;
  }
}

/**
 * Resolve a toolchain in priority order: the explicit env override, then the
 * workspace's own `node_modules`, then the nearest ancestor `node_modules` (a
 * repo root when the workspace is nested in one). `envInvalid` distinguishes a
 * typo'd override from "not installed" so the note can name the bad path.
 */
function resolveNodeScript(
  envValue: string | undefined,
  workspaceDir: string,
  segments: readonly string[]
): { tool?: ResolvedTool; envInvalid?: string } {
  const raw = envValue?.trim();
  if (raw) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(workspaceDir, raw);
    if (isFile(abs)) return { tool: { path: abs, viaNode: isNodeScript(abs) } };
    return { envInvalid: abs };
  }
  const found = findUp(workspaceDir, segments);
  return found ? { tool: { path: found, viaNode: isNodeScript(found) } } : {};
}

function hasEslintConfig(workspaceDir: string): boolean {
  if (ESLINT_CONFIG_FILES.some((name) => isFile(path.join(workspaceDir, name)))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8')) as {
      eslintConfig?: unknown;
    };
    return pkg.eslintConfig !== undefined && pkg.eslintConfig !== null;
  } catch {
    return false;
  }
}

async function runToolchain(
  tool: ResolvedTool,
  args: readonly string[],
  ctx: ToolContext,
  timeoutMs: number
): Promise<RunOutcome> {
  const command = tool.viaNode ? process.execPath : tool.path;
  const argv = tool.viaNode ? [tool.path, ...args] : [...args];
  try {
    const result = await runProcess(command, {
      args: argv,
      cwd: canonicalWorkspace(ctx.workspaceDir),
      timeout: timeoutMs,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: false,
    };
  } catch (err) {
    if (err instanceof ProcessError) {
      return {
        stdout: err.stdout,
        stderr: err.stderr,
        exitCode: err.exitCode,
        timedOut: err.timedOut,
      };
    }
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }
}

function toPosix(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/** Workspace-relative when possible, absolute otherwise; '' stays ''. */
function normalizeFile(raw: string, workspaceDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const abs = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceDir, trimmed);
  const rel = path.relative(path.resolve(workspaceDir), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}

function capMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MESSAGE_MAX_CHARS
    ? `${oneLine.slice(0, MESSAGE_MAX_CHARS - 1)}…`
    : oneLine;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseTscOutput(stdout: string, workspaceDir: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let last: Diagnostic | undefined;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const matched = TSC_LOCATED_RE.exec(line) ?? TSC_COLON_RE.exec(line);
    if (matched) {
      const [, file, lineText, columnText, severity, code, message] = matched;
      last = {
        file: normalizeFile(file ?? '', workspaceDir),
        line: Number(lineText),
        column: Number(columnText),
        severity: severity === 'warning' ? 'warning' : 'error',
        code: code ?? 'TS',
        message: capMessage(message ?? ''),
        source: 'tsc',
      };
      diagnostics.push(last);
      continue;
    }
    const global = TSC_GLOBAL_RE.exec(line.trim());
    if (global) {
      const [, severity, code, message] = global;
      last = {
        file: '',
        line: 0,
        column: 0,
        severity: severity === 'warning' ? 'warning' : 'error',
        code: code ?? 'TS',
        message: capMessage(message ?? ''),
        source: 'tsc',
      };
      diagnostics.push(last);
      continue;
    }
    // Indented follow-up of the previous error (tsc's "  Types of property …"
    // continuation lines) belongs to that diagnostic, not to a new one.
    if (last && /^\s{2,}\S/.test(line) && !/^Found \d+ error/.test(line.trim())) {
      last.message = capMessage(`${last.message} ${line.trim()}`);
    }
  }
  return diagnostics;
}

function parseEslintOutput(
  stdout: string,
  workspaceDir: string
): { diagnostics: Diagnostic[]; parseError?: string } {
  const text = stdout.trim();
  if (!text) return { diagnostics: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some plugins print banners before the JSON array; keep the array body.
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start)
      return { diagnostics: [], parseError: 'no JSON array in output' };
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { diagnostics: [], parseError: 'unparseable JSON' };
    }
  }
  if (!Array.isArray(parsed)) return { diagnostics: [], parseError: 'output is not a JSON array' };

  const diagnostics: Diagnostic[] = [];
  for (const fileEntry of parsed) {
    const entry = fileEntry as { filePath?: unknown; messages?: unknown };
    const filePath = typeof entry.filePath === 'string' ? entry.filePath : '';
    if (!Array.isArray(entry.messages)) continue;
    for (const raw of entry.messages) {
      const finding = raw as {
        line?: unknown;
        column?: unknown;
        severity?: unknown;
        ruleId?: unknown;
        message?: unknown;
        fatal?: unknown;
      };
      // 2 = error, 1 = warning; 0 is a "disable" hint, not a finding.
      const severity: DiagnosticSeverity | undefined =
        finding.severity === 2 ? 'error' : finding.severity === 1 ? 'warning' : undefined;
      if (!severity) continue;
      const fallbackCode = finding.fatal === true ? 'fatal' : 'eslint';
      diagnostics.push({
        file: normalizeFile(filePath, workspaceDir),
        line: asNumber(finding.line),
        column: asNumber(finding.column),
        severity,
        code: typeof finding.ruleId === 'string' && finding.ruleId ? finding.ruleId : fallbackCode,
        message: capMessage(typeof finding.message === 'string' ? finding.message : ''),
        source: 'eslint',
      });
    }
  }
  return { diagnostics };
}

function resolveMax(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function resolveFilters(raw: unknown, workspaceDir: string): string[] {
  if (!Array.isArray(raw)) return [];
  const root = path.resolve(workspaceDir);
  const filters: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const value = entry.trim();
    filters.push(path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value));
  }
  return filters;
}

/** A path filter keeps a finding under that file/dir. Project-level tsc errors always stay. */
function matchesPaths(
  diagnostic: Diagnostic,
  filters: readonly string[],
  workspaceDir: string
): boolean {
  if (filters.length === 0) return true;
  if (!diagnostic.file) return true;
  const abs = path.isAbsolute(diagnostic.file)
    ? path.resolve(diagnostic.file)
    : path.resolve(workspaceDir, diagnostic.file);
  return filters.some((filter) => abs === filter || abs.startsWith(`${filter}${path.sep}`));
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.source.localeCompare(b.source) ||
    a.code.localeCompare(b.code)
  );
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? capMessage(line) : '';
}

function renderDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.file
    ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`
    : '(project)';
  return `${where} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message} (${diagnostic.source})`;
}

export const diagnosticsTool: Tool<DiagnosticsInput> = {
  name: 'diagnostics',
  description:
    'Run the workspace diagnostics toolchains (tsc, ESLint, and pytest when chosen/auto-detected) and ' +
    'return normalized findings (file:line:col, severity, code, message, source) sorted and capped. ' +
    'Use it before/after an edit to see real type/lint/test failures instead of grepping build output. ' +
    'Readonly: tsc runs with --noEmit, eslint without --fix, pytest without cache writes. A missing ' +
    'toolchain or an empty result is reported explicitly. Not for arbitrary shell commands (exec).',
  metadata: {
    leanDescription:
      'Run workspace tsc/eslint/pytest and return normalized findings; readonly. Not for exec.',
    sideEffectClass: 'readonly',
    planMode: 'allow',
    requiresApproval: false,
    // Re-running after an edit must observe the new state, not replay the
    // previous turn's diagnostics from the loop cache.
    noReplay: true,
    timeoutMs: 240_000,
    maxResultTokens: 5_000,
    truncationHint:
      'narrow with paths, lower max, or fix the reported findings instead of re-running the whole toolchain',
  },
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Only keep findings at or under these files/directories (workspace-relative or absolute). ' +
          'The toolchain still checks the project; filters apply to the returned list.',
      },
      max: {
        type: 'number',
        description: `Maximum findings to render (default ${DEFAULT_MAX}, maximum ${MAX_LIMIT}).`,
      },
      kind: {
        type: 'string',
        enum: ['auto', 'node', 'python'],
        description:
          'Toolchain family: auto (default — Node when tsconfig/ESLint exists, otherwise pytest when ' +
          'Python tests exist), node (tsc + ESLint only), or python (pytest only).',
      },
    },
  },
  async execute(input, ctx: ToolContext): Promise<string> {
    const workspaceDir = canonicalWorkspace(ctx.workspaceDir);
    const max = resolveMax(input?.max);
    const filters = resolveFilters(input?.paths, workspaceDir);
    const notes: string[] = [];
    const sources: DiagnosticSource[] = [];
    const diagnostics: Diagnostic[] = [];

    const hasTsconfig = isFile(path.join(workspaceDir, 'tsconfig.json'));
    const hasEslint = hasEslintConfig(workspaceDir);
    const hasPython = hasPythonTests(workspaceDir);
    const requested = input?.kind ?? 'auto';
    const runNode = requested === 'node' || (requested === 'auto' && (hasTsconfig || hasEslint));
    const runPython =
      requested === 'python' || (requested === 'auto' && !hasTsconfig && !hasEslint && hasPython);
    if (!runNode && !runPython) {
      return [
        `No diagnostics sources in ${workspaceDir}: no tsconfig.json, ESLint config, or Python test files were found.`,
        'Add a tsconfig.json (TypeScript), an ESLint config, or test_*.py/tests/, then re-run; nothing was executed.',
      ].join('\n');
    }

    if (runNode && hasTsconfig) {
      const resolved = resolveNodeScript(process.env.MOSS_TSC_PATH, workspaceDir, TSC_SEGMENTS);
      if (resolved.envInvalid) {
        notes.push(
          `TypeScript: MOSS_TSC_PATH points to ${resolved.envInvalid}, which is not a file — fix the override or unset it.`
        );
      } else if (!resolved.tool) {
        notes.push(
          'TypeScript: tsconfig.json found but no tsc toolchain resolved — install typescript in the workspace ' +
            '(npm install -D typescript) or set MOSS_TSC_PATH to node_modules/typescript/bin/tsc.'
        );
      } else {
        sources.push('tsc');
        const run = await runToolchain(
          resolved.tool,
          ['--noEmit', '--pretty', 'false'],
          ctx,
          TSC_TIMEOUT_MS
        );
        if (run.spawnError) {
          notes.push(`TypeScript: could not start tsc (${run.spawnError}).`);
        } else {
          if (run.timedOut)
            notes.push(
              'TypeScript: tsc timed out; raising the budget or narrowing the project is needed.'
            );
          const parsed = parseTscOutput(run.stdout, workspaceDir);
          diagnostics.push(...parsed);
          if (parsed.length === 0 && run.exitCode !== 0) {
            const detail = firstLine(run.stderr) || firstLine(run.stdout);
            notes.push(
              `TypeScript: tsc exited ${run.exitCode ?? 'unknown'} without parseable diagnostics${detail ? ` — ${detail}` : ''}.`
            );
          }
        }
      }
    }

    if (runNode && hasEslint) {
      const resolved = resolveNodeScript(
        process.env.MOSS_ESLINT_PATH,
        workspaceDir,
        ESLINT_SEGMENTS
      );
      if (resolved.envInvalid) {
        notes.push(
          `ESLint: MOSS_ESLINT_PATH points to ${resolved.envInvalid}, which is not a file — fix the override or unset it.`
        );
      } else if (!resolved.tool) {
        notes.push(
          'ESLint: an ESLint config was found but no eslint toolchain resolved — install eslint in the workspace ' +
            '(npm install -D eslint) or set MOSS_ESLINT_PATH to node_modules/eslint/bin/eslint.js.'
        );
      } else {
        sources.push('eslint');
        const run = await runToolchain(
          resolved.tool,
          ['.', '--format', 'json'],
          ctx,
          ESLINT_TIMEOUT_MS
        );
        if (run.spawnError) {
          notes.push(`ESLint: could not start eslint (${run.spawnError}).`);
        } else {
          if (run.timedOut)
            notes.push(
              'ESLint: eslint timed out; raising the budget or narrowing paths is needed.'
            );
          const parsed = parseEslintOutput(run.stdout, workspaceDir);
          diagnostics.push(...parsed.diagnostics);
          if (parsed.parseError) {
            const detail = firstLine(run.stderr);
            notes.push(`ESLint: ${parsed.parseError}${detail ? ` — ${detail}` : ''}.`);
          } else if (parsed.diagnostics.length === 0 && run.exitCode !== 0 && run.exitCode !== 1) {
            // 1 is the normal "findings present" exit; anything else is a
            // config/crash failure that produced no findings.
            const detail = firstLine(run.stderr) || firstLine(run.stdout);
            notes.push(
              `ESLint: exited ${run.exitCode ?? 'unknown'} without diagnostics${detail ? ` — ${detail}` : ''}.`
            );
          }
        }
      }
    }

    let pytestCounts: { failed: number; passed: number } | undefined;
    if (runPython) {
      sources.push('pytest');
      const outcome = await runPytest(workspaceDir, ctx, filters);
      diagnostics.push(...outcome.diagnostics);
      notes.push(...outcome.notes);
      if (outcome.ran) pytestCounts = { failed: outcome.failed, passed: outcome.passed };
    }

    const filtered = diagnostics.filter((diagnostic) =>
      matchesPaths(diagnostic, filters, workspaceDir)
    );
    const sorted = [...filtered].sort(compareDiagnostics);
    const shown = sorted.slice(0, max);
    const errors = filtered.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = filtered.length - errors;
    const from = sources.length > 0 ? sources.join(', ') : 'no toolchain';

    const lines = [`${errors} error(s), ${warnings} warning(s) from ${from}`];
    if (pytestCounts) {
      lines.push(
        `pytest: ${pytestCounts.failed} failed, ${pytestCounts.passed} passed — failures are listed below with file:line.`
      );
    }
    if (filters.length > 0) {
      lines.push(
        `Filtered to: ${filters.map((filter) => normalizeFile(filter, workspaceDir)).join(', ')}`
      );
    }
    if (shown.length === 0) {
      lines.push(
        sources.length === 0
          ? 'No diagnostics were run — see the notes below.'
          : 'No diagnostics found — the checked project is clean.'
      );
    } else {
      for (const diagnostic of shown) lines.push(renderDiagnostic(diagnostic));
      if (filtered.length > shown.length) {
        lines.push(
          `(${filtered.length} diagnostics total; showing ${shown.length} — raise max to see more.)`
        );
      }
    }
    if (notes.length > 0) {
      lines.push('Notes:', ...notes.map((note) => `- ${note}`));
    }
    return lines.join('\n');
  },
};
