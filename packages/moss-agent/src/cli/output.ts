import fs from 'node:fs';
import path from 'node:path';
import type { MossAgentEvent } from '../core/index.js';
import { redactSensitiveData } from '../observability/redact.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { ui } from './ui.js';
import { diffLinesForApproval } from './approval-detail.js';
import { renderMarkdown } from './tui-utils.js';
import { summarizeVerificationResult } from '../tools/harness-tools.js';
import {
  extractCommandFailurePreview,
  extractCommandOutputPreview,
} from '../tools/tool-helpers.js';
import { subscribeBackgroundLifecycle } from '../tools/background-exec.js';
import {
  formatBackgroundCompletionNotice,
  formatBackgroundCompletionFlash,
} from './background-completion-ui.js';
import { isZhLocale } from './cli-locale.js';


const CODE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'move_file']);

const EXEC_LIKE_TOOLS = new Set(['exec', 'exec_background', 'device_exec']);

const TEST_COMMAND_RE =
  /\b(npm (run )?test|npm t|yarn test|pnpm test|node\s+--test|pytest|vitest|jest|mocha|go test|cargo test|make test|npm run (build|typecheck|lint)|tsc)\b/;







function discoverableTestCommand(workspaceDir: string | undefined): string | null {
  if (!workspaceDir) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
    const test = pkg?.scripts?.test;
    if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
      return 'npm test';
    }
  } catch {
    
  }
  return null;
}

export type CliDetailMode = 'quiet' | 'progress' | 'verbose';

interface CliOutputStreams {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

interface CliRunRendererOptions extends Partial<CliOutputStreams> {
  detailMode?: CliDetailMode;
  interactive?: boolean;
  
  workspaceDir?: string;
}

interface RendererState {
  answerOpen: boolean;

  answerStarted: boolean;
  thinkingOpen: boolean;
  thinkingNoted: boolean;
  toolStartTimes: Map<string, number>;
  toolInputs: Map<string, Record<string, unknown>>;
  /** Lines printed for in-progress tools — so we can overwrite them on tool_end. */
  toolLineIds: Map<string, number>;
  /** Whether any JS/TS files were edited (to avoid false-positive npm test hints for Python/docs). */
  editedJsTs: boolean;
  ranTests: boolean;
  /** Buffer for the current answer segment — flushed on segment end. */
  answerBuffer: string;
  /** True when deltas were already written live (avoid double-print on flush). */
  answerLive: boolean;
}

// ── CC-style spinner ─────────────────────────────────────────────────────────
// Frames modeled on Claude Code's "Working (Xs · esc to interrupt)" indicator.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** verbose 模式下 tool_end 输出最多展示的行数，超出部分以 "... N more lines ..." 折叠。 */
const MAX_DETAIL_LINES = 200;

class CliSpinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private startedAt = 0;

  constructor(private readonly stderr: Pick<NodeJS.WriteStream, 'write'>) {}

  start(label: string): void {
    if (this.active) return;
    this.active = true;
    this.frame = 0;
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
      const elapsedStr = elapsed > 0 ? ` ${elapsed}s` : '';
      this.stderr.write(
        `\r\x1b[K${ui.yellow(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length])} ${label}${elapsedStr}`
      );
      this.frame++;
    }, 80);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stderr.write('\r\x1b[K');
  }
}


export function resolveCliDetailMode(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): CliDetailMode {
  const raw = (env.MOSS_CLI_DETAIL || '').toLowerCase();
  if (argv.includes('--quiet') || raw === 'quiet' || raw === 'off' || raw === 'none')
    return 'quiet';

  
  const hasJsonOutputFormat =
    argv.includes('--json') ||
    argv.some(
      (a) => a.startsWith('--output-format=json') || a.startsWith('--output-format=stream-json')
    ) ||
    (argv.includes('--output-format') &&
      argv.some(
        (a, i) =>
          i > 0 && argv[i - 1] === '--output-format' && (a === 'json' || a === 'stream-json')
      ));

  if (!raw && (hasJsonOutputFormat || env.MOSS_LOG_JSON === '1')) return 'quiet';

  if (
    raw === 'verbose' ||
    raw === 'debug' ||
    env.MOSS_VERBOSE_CLI === 'true' ||
    env.MOSS_VERBOSE_TOOLS === 'true' ||
    env.MOSS_SHOW_THINKING === 'true'
  ) {
    return 'verbose';
  }
  return 'progress';
}

export function summarizeForCli(value: unknown, maxChars = 280): string {
  
  
  
  
  
  const redacted = redactSensitiveData(value, { skipFileContentHeuristic: true });
  const raw =
    typeof redacted === 'string'
      ? redacted
      : (JSON.stringify(redacted, null, 0) ?? String(redacted));
  const oneLine = sanitizeSecrets(raw).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractToolCommand(_toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command;
  return undefined;
}

function extractExecExitCode(toolName: string, result: string | undefined): number | undefined {
  if (!result || !EXEC_LIKE_TOOLS.has(toolName)) return undefined;
  const match = result.match(/^Command failed \(exit (\d+)\):/m);
  return match ? Number(match[1]) : undefined;
}

function formatErrorResult(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') {
    if (result.includes('ENOENT')) return '文件不存在';
    if (result.includes('EACCES')) return '权限不足';
    if (result.includes('EISDIR')) return '目标是一个目录';
    const cleaned = result.replace(/Execution error:\s*/i, '').trim();
    return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
  }
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (obj.error) return String(obj.error);
    if (obj.message) return String(obj.message);
  }
  return summarizeForCli(result, 200);
}





function extractToolTarget(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const truncate = (s: string, max = 60): string =>
    s.length <= max ? s : `${s.slice(0, max - 1)}…`;


  if (
    toolName === 'read_file' ||
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'move_file'
  ) {
    const p = obj.path ?? obj.filePath ?? obj.source ?? obj.destination;
    if (typeof p === 'string') {
      // Prefer relative path over basename so monorepo edits are locatable.
      return truncate(p.replace(/\\/g, '/'), 72);
    }
    return '';
  }
  if (toolName === 'multi_edit' && Array.isArray(obj.edits)) {
    const paths = (obj.edits as Array<Record<string, unknown>>)
      .map((e) => (typeof e.path === 'string' ? e.path : ''))
      .filter(Boolean);
    if (paths.length === 1) return truncate(paths[0]!.replace(/\\/g, '/'), 72);
    if (paths.length > 1) {
      return truncate(`${paths[0]} +${paths.length - 1} more`.replace(/\\/g, '/'), 72);
    }
    return '';
  }
  if (toolName === 'apply_patch') {
    const p = obj.path ?? obj.filePath;
    if (typeof p === 'string') return truncate(String(p).replace(/\\/g, '/'), 72);
    const patch = typeof obj.patch === 'string' ? obj.patch : '';
    const m = patch.match(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(\S+)/i);
    if (m?.[1]) return truncate(m[1].replace(/\\/g, '/'), 72);
    return '';
  }

  if (toolName === 'search_code' || toolName === 'search_files') {
    const pattern = obj.pattern ?? obj.query;
    if (typeof pattern === 'string') return truncate(pattern, 40);
    return '';
  }
  if (toolName === 'list_directory') {
    const p = obj.path ?? obj.dir;
    if (typeof p === 'string') return truncate(path.basename(p) || p);
    return '';
  }

  if (toolName === 'todo_write') {
    const todos = obj.todos;
    if (Array.isArray(todos)) {
      const n = todos.length;
      const done = todos.filter(
        (t) => t && typeof t === 'object' && (t as { status?: string }).status === 'completed'
      ).length;
      const active = todos.find(
        (t) => t && typeof t === 'object' && (t as { status?: string }).status === 'in_progress'
      ) as { content?: string } | undefined;
      const focus =
        typeof active?.content === 'string' && active.content.trim()
          ? truncate(active.content.trim(), 36)
          : '';
      return focus ? `${done}/${n} · ${focus}` : `${done}/${n} items`;
    }
    return '';
  }

  if (toolName === 'multi_edit') {
    const edits = obj.edits;
    if (Array.isArray(edits)) {
      const paths = new Set<string>();
      for (const e of edits) {
        if (e && typeof e === 'object') {
          const p = (e as { path?: string; filePath?: string }).path
            ?? (e as { filePath?: string }).filePath;
          if (typeof p === 'string' && p) paths.add(path.basename(p));
        }
      }
      if (paths.size === 1) return `${[...paths][0]} ×${edits.length}`;
      if (paths.size > 1) return `${paths.size} files ×${edits.length}`;
      return `${edits.length} edits`;
    }
    return '';
  }

  if (toolName === 'exec' || toolName === 'exec_background') {
    const cmd = obj.command;
    if (typeof cmd === 'string') return truncate(cmd);
    return '';
  }

  if (toolName === 'exec_logs') {
    const id = obj.id;
    if (typeof id === 'string' || typeof id === 'number') return truncate(String(id), 30);
    return '';
  }

  if (toolName === 'exec_stop') {
    const id = obj.id;
    if (typeof id === 'string' || typeof id === 'number') return truncate(String(id), 30);
    return '';
  }

  if (toolName.startsWith('web_search')) {
    const q = obj.query ?? obj.question;
    if (typeof q === 'string') return truncate(q, 40);
    return '';
  }

  if (toolName.startsWith('web_fetch')) {
    const url = obj.url;
    if (typeof url === 'string') return truncate(url, 60);
    return '';
  }

  if (toolName === 'web_browser_agent' || toolName === 'web_browser_control' || toolName === 'web_browser_fetch') {
    const url = obj.url ?? obj.action;
    if (typeof url === 'string') return truncate(url, 50);
    return '';
  }

  if (toolName === 'vision_analyze') {
    const image = obj.image ?? obj.imagePath;
    if (typeof image === 'string') return truncate(path.basename(image), 40);
    return '';
  }

  if (toolName === 'screenshot_capture') {
    const target = obj.target ?? obj.window;
    if (typeof target === 'string') return truncate(target, 40);
    return '';
  }

  if (toolName === 'code_diagnostics' || toolName === 'run_tests' || toolName === 'verify_fix') {
    const cmd = obj.command ?? obj.test_command ?? obj.build_command;
    if (typeof cmd === 'string' && cmd.trim()) return truncate(cmd, 40);
    if (toolName === 'run_tests') return 'npm test';
    if (toolName === 'verify_fix') return 'build+typecheck+tests';
    return '';
  }

  if (toolName === 'plan') {
    const action = obj.action;
    const goal = obj.goal;
    if (typeof action === 'string') return truncate(action, 40);
    if (typeof goal === 'string') return truncate(goal, 40);
    return '';
  }

  if (toolName === 'plan_step') {
    const stepIndex = obj.stepIndex;
    const status = obj.status;
    if (typeof stepIndex === 'number') return `step ${stepIndex}`;
    if (typeof status === 'string') return truncate(status, 30);
    return '';
  }

  if (toolName === 'eval') {
    const action = obj.action;
    const suite = obj.suite;
    if (typeof action === 'string') return truncate(action, 40);
    if (typeof suite === 'string') return truncate(suite, 40);
    return '';
  }

  if (toolName === 'generate_structured') {
    const schema = obj.schema;
    if (typeof schema === 'string') return truncate(schema, 40);
    return '';
  }

  if (toolName === 'install_skill') {
    const skill = obj.skill ?? obj.skillName;
    if (typeof skill === 'string') return truncate(skill, 40);
    return '';
  }

  if (toolName === 'fleet_batch') {
    const action = obj.action;
    const deviceCount =
      typeof obj.deviceCount === 'number'
        ? obj.deviceCount
        : Array.isArray(obj.devices)
          ? obj.devices.length
          : undefined;
    const actionStr = typeof action === 'string' ? truncate(action, 30) : '';
    const countStr = typeof deviceCount === 'number' ? ` (${deviceCount} devices)` : '';
    return actionStr + countStr;
  }

  if (toolName.startsWith('memory_read') || toolName.startsWith('memory_write')) {
    const key = obj.key ?? obj.query;
    if (typeof key === 'string') return truncate(key, 40);
    return '';
  }

  if (toolName.startsWith('browser_')) {
    const url = obj.url ?? obj.action;
    if (typeof url === 'string') return truncate(url, 50);
    return '';
  }
  return '';
}

export function createCliRunRenderer(options: CliRunRendererOptions = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const detailMode = options.detailMode ?? resolveCliDetailMode();
  const interactive = options.interactive ?? Boolean((stderr as NodeJS.WriteStream).isTTY);
  const spinner = interactive ? new CliSpinner(stderr) : null;
  const state: RendererState = {
    answerOpen: false,
    answerStarted: false,
    editedJsTs: false,
    ranTests: false,
    thinkingOpen: false,
    thinkingNoted: false,
    toolStartTimes: new Map(),
    toolInputs: new Map(),
    toolLineIds: new Map(),
    answerBuffer: '',
    /** True when answer text was already written live (token streaming). */
    answerLive: false,
  };

  const isQuiet = detailMode === 'quiet';
  const isVerbose = detailMode === 'verbose';

  // CC-style: ⏺ (solid circle) for all tool activity — green on success,
  // red/yellow on failure, yellow for in-progress (matches CC's orange dot).
  function mark(kind: 'info' | 'ok' | 'fail' = 'info'): string {
    if (!interactive) {
      if (kind === 'ok') return '✓';
      if (kind === 'fail') return '✗';
      return '·';
    }
    if (kind === 'ok') return ui.green('⏺');
    if (kind === 'fail') return ui.red('⏺');    // red for failures — visually distinct from yellow in-progress
    return ui.yellow('⏺');
  }

  function stderrLine(line: string): void {
    stderr.write(`${line}\n`);
  }

  /**
   * Flush the accumulated answer buffer to stdout with markdown rendering.
   * Uses renderMarkdown so code blocks get syntax highlighting, tables are
   * formatted, etc. Falls back to the raw buffer if rendering produces nothing.
   */
  function flushAnswerBuffer(): void {
    if (!state.answerBuffer) return;
    const raw = state.answerBuffer;
    state.answerBuffer = '';
    // Live token streaming already printed plain text; do not double-write.
    if (state.answerLive) {
      state.answerLive = false;
      return;
    }
    try {
      const rendered = renderMarkdown(raw);
      stdout.write(rendered || raw);
    } catch {
      stdout.write(raw);
    }
  }

  function breakAnswerForStatus(): void {
    if (state.answerOpen) {
      flushAnswerBuffer();
      stderr.write('\n');
      state.answerOpen = false;
    }
    if (state.thinkingOpen) {
      stderr.write('\n');
      state.thinkingOpen = false;
    }
  }

  // User-visible background completions for oneshot/REPL (TUI has its own subscription).
  // Quiet mode still prints one line so long tests/builds are not silent.
  const unsubscribeBackground = subscribeBackgroundLifecycle((snap) => {
    if (snap.status === 'running') return;
    const zh = isZhLocale();
    const failed = snap.status === 'error' || (snap.exitCode !== null && snap.exitCode !== 0);
    if (isQuiet) {
      stderrLine(`${mark(failed ? 'fail' : 'ok')} ${formatBackgroundCompletionFlash(snap, zh)}`);
      return;
    }
    breakAnswerForStatus();
    spinner?.stop();
    const notice = formatBackgroundCompletionNotice(snap, zh);
    for (const line of notice.split('\n')) {
      stderrLine(`${mark(failed ? 'fail' : 'ok')} ${line}`);
    }
  });

  function handle(event: MossAgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        if (!isQuiet) {
          breakAnswerForStatus();
          spinner?.stop();
          if (isVerbose) {
            stderrLine(`${mark()} thinking${ui.dim(` (turn ${event.turn})`)}`);
          } else if (interactive) {
            spinner?.start(`Working${event.turn > 1 ? `… (turn ${event.turn})` : ''}`);
          } else if (event.turn > 2) {
            // Oneshot / headless: suppress the first two turns (normal single-tool
            // calls don't need a "working" message). Only signal turn 3+ which
            // indicates a genuine multi-step tool loop where the user needs feedback.
            stderrLine(ui.dim(`working…`));
          }
          state.thinkingNoted = true;
        }
        break;
      case 'thinking_delta':
        if (isQuiet) break;
        breakAnswerForStatus();
        if (isVerbose && process.env.MOSS_SHOW_THINKING !== 'false') {
          if (!state.thinkingOpen) {
            stderrLine('[thinking]');
            state.thinkingOpen = true;
          }
          stderr.write(String(redactSensitiveData(event.delta)));
        } else if (!state.thinkingNoted) {
          spinner?.stop();
          stderrLine(`${mark()} thinking ${ui.dim('reasoning')}`);
          state.thinkingNoted = true;
        }
        break;
      case 'text_delta':
        spinner?.stop();
        if (state.thinkingOpen) {
          stderr.write('\n');
          state.thinkingOpen = false;
        }
        // Stream tokens to the terminal as they arrive (TTFT). Markdown
        // re-render of the whole answer was buffering until paragraph end or
        // turn end, which made even true SSE look non-streaming for short
        // replies like "PONG". Live-write plain deltas; skip double-print on flush.
        if (!state.answerOpen && state.answerStarted) {
          flushAnswerBuffer();
          stdout.write('\n\n');
        }
        {
          const delta = String(event.delta ?? '');
          state.answerBuffer += delta;
          state.answerOpen = true;
          state.answerStarted = true;
          if (delta) {
            stdout.write(delta);
            state.answerLive = true;
          }
        }
        break;
      case 'tool_start': {
        spinner?.stop();
        state.toolStartTimes.set(event.toolCallId, Date.now());
        state.toolInputs.set(event.toolCallId, event.input);
        if (CODE_EDIT_TOOLS.has(event.toolName)) {
          // Track JS/TS files specifically to avoid false npm test hints for Python, docs, etc.
          const pathVal = (event.input as { path?: unknown } | undefined)?.path;
          if (typeof pathVal === 'string' && /\.[cm]?[jt]sx?$/.test(pathVal)) {
            state.editedJsTs = true;
          }
        }
        if (event.toolName === 'run_tests') {
          state.ranTests = true;
        } else if (event.toolName === 'exec' || event.toolName === 'device_exec') {
          const cmd = (event.input as { command?: unknown } | undefined)?.command;
          if (typeof cmd === 'string' && TEST_COMMAND_RE.test(cmd)) state.ranTests = true;
        }
        if (!isQuiet) {
          breakAnswerForStatus();
          // CC-style: ⏺ tool_name (target) — yellow dot while in progress
          const target = extractToolTarget(event.toolName, event.input);
          const targetStr = target ? ` ${ui.dim(`(${target})`)}` : '';
          const fullCommand = extractToolCommand(event.toolName, event.input);
          if (isVerbose && fullCommand) {
            stderrLine(`${mark()} ${ui.bold(event.toolName)}${targetStr}`);
            stderrLine(`  ${ui.dim(fullCommand)}`);
            state.toolLineIds.set(event.toolCallId, 0); // multi-line: can't overwrite
          } else {
            // Single-line: write without newline so tool_end can overwrite it.
            if (interactive) {
              stderr.write(`${mark()} ${ui.bold(event.toolName)}${targetStr}`);
              state.toolLineIds.set(event.toolCallId, 1); // single-line in-progress
            } else {
              stderrLine(`${mark()} ${ui.bold(event.toolName)}${targetStr}`);
              state.toolLineIds.set(event.toolCallId, 0);
            }
          }
        }
        break;
      }
      case 'tool_end': {
        if (!isQuiet) {
          const startedAt = state.toolStartTimes.get(event.toolCallId);
          state.toolStartTimes.delete(event.toolCallId);
          const toolInput = state.toolInputs.get(event.toolCallId);
          state.toolInputs.delete(event.toolCallId);
          const lineMode = state.toolLineIds.get(event.toolCallId) ?? 0;
          state.toolLineIds.delete(event.toolCallId);
          const msElapsed = startedAt ? Date.now() - startedAt : 0;
          // Highlight slow tools (>3s) in yellow — a signal of potential hangs/slow network
          const elapsed = msElapsed
            ? ` ${msElapsed > 3000 ? ui.yellow(`${msElapsed}ms`) : ui.dim(`${msElapsed}ms`)}`
            : '';
          const statusKind = event.isError || event.aborted ? 'fail' : 'ok';
          const failReason = event.isError ? formatErrorResult(event.result) : '';
          const abortReason = event.aborted ? `aborted (${event.aborted.by})` : '';
          // Color error messages red and abort messages yellow for immediate visual attention
          const statusNote = failReason ? ui.red(`: ${failReason}`) : abortReason ? ui.yellow(` ${abortReason}`) : '';

          const target = extractToolTarget(event.toolName, toolInput);
          let targetStr = target ? ` ${ui.dim(`(${target})`)}` : '';
          // Prefer structured verification summary on the completed line so
          // edit→verify feedback is visible without --verbose.
          if (
            typeof event.result === 'string' &&
            (event.toolName === 'run_tests' ||
              event.toolName === 'verify_fix' ||
              event.toolName === 'code_diagnostics')
          ) {
            const summary = summarizeVerificationResult(event.toolName, event.result);
            if (summary) {
              targetStr = ` ${ui.dim(`(${summary})`)}`;
            }
          } else if (
            typeof event.result === 'string' &&
            (event.toolName === 'exec' ||
              event.toolName === 'device_exec' ||
              event.toolName === 'docker_exec' ||
              event.toolName === 'exec_background')
          ) {
            if (statusKind === 'fail') {
              const tail = extractCommandFailurePreview(event.result, 1)[0];
              if (tail) {
                // Keep command target if present, append failure hint.
                const hint = tail.length > 48 ? `${tail.slice(0, 47)}…` : tail;
                targetStr = target
                  ? ` ${ui.dim(`(${target})`)} ${ui.red(hint)}`
                  : ` ${ui.red(hint)}`;
              }
            } else if (statusKind === 'ok' && !isVerbose) {
              // Successful long commands: one-line tail so build/verify conclusions
              // are visible without --verbose (TUI parity, quieter than multi-line).
              const tailLines = extractCommandOutputPreview(event.result, {
                maxLines: 1,
                minLines: 4,
                minChars: 160,
              });
              // extractCommandOutputPreview may prefix an "earlier lines" marker when
              // maxLines>1; with maxLines=1 it returns only the final line(s).
              const tail = tailLines.filter((l) => !l.startsWith('…')).at(-1) ?? tailLines.at(-1);
              if (tail) {
                const hint = tail.length > 56 ? `${tail.slice(0, 55)}…` : tail;
                targetStr = target
                  ? ` ${ui.dim(`(${target})`)} ${ui.dim(hint)}`
                  : ` ${ui.dim(hint)}`;
              }
            }
          }

          if (lineMode === 1 && interactive) {
            // Overwrite the in-progress line with the completed result.
            // \r resets to line start, \x1b[K clears rest of line.
            stderr.write(`\r\x1b[K${mark(statusKind)} ${ui.bold(event.toolName)}${targetStr}${elapsed}${statusNote}\n`);
          } else if (!isVerbose) {
            // Non-interactive or multi-line start: print the completion line.
            stderrLine(`${mark(statusKind)} ${ui.bold(event.toolName)}${targetStr}${elapsed}${statusNote}`);
          } else {
            // Verbose: include result summary and extra details.
            const resultSummary = summarizeForCli(event.result);
            // Color the result summary: red on error (most useful debug info), dim on success
            const summaryColored = resultSummary
              ? (statusKind === 'fail' ? ui.red(resultSummary) : ui.dim(resultSummary))
              : '';
            stderrLine(
              summaryColored
                ? `${mark(statusKind)} ${ui.bold(event.toolName)}${targetStr}${elapsed}${statusNote}: ${summaryColored}`
                : `${mark(statusKind)} ${ui.bold(event.toolName)}${targetStr}${elapsed}${statusNote}`
            );
            const fullCommand = extractToolCommand(event.toolName, toolInput);
            if (fullCommand) stderrLine(`  ${ui.dim(fullCommand)}`);
            const exitCode = extractExecExitCode(event.toolName, event.result);
            // Non-zero exit code = failure; highlight in red
            if (exitCode !== undefined) {
              const exitStr = exitCode === 0 ? ui.dim(`exit ${exitCode}`) : ui.red(`exit ${exitCode}`);
              stderrLine(`  ${exitStr}`);
            }
          }

          // Code-change previews in progress + verbose (not quiet): show what
          // was written so oneshot users can audit edits without --verbose.
          // Cap is shorter in progress mode to keep the terminal scannable.
          if (
            !event.isError &&
            !event.aborted &&
            CODE_EDIT_TOOLS.has(event.toolName) &&
            toolInput &&
            typeof toolInput === 'object'
          ) {
            const ti = toolInput as Record<string, unknown>;
            const previewCap = isVerbose ? MAX_DETAIL_LINES : 24;
            if (event.toolName === 'edit_file'
              && typeof ti.old_string === 'string'
              && typeof ti.new_string === 'string') {
              const diff = diffLinesForApproval(ti.old_string, ti.new_string);
              if (diff && diff.length > 0) {
                stderrLine(`  ${ui.dim('diff:')}`);
                for (let i = 0; i < Math.min(diff.length, previewCap); i += 1) {
                  const line = diff[i]!;
                  const tone = line.startsWith('- ') ? ui.red : line.startsWith('+ ') ? ui.green : ui.dim;
                  stderrLine(`    ${tone(line)}`);
                }
                if (diff.length > previewCap) {
                  stderrLine(`    ${ui.dim(`... ${diff.length - previewCap} more lines ...`)}`);
                }
              }
            } else if (event.toolName === 'write_file' && typeof ti.content === 'string') {
              const lines = ti.content.split('\n');
              stderrLine(`  ${ui.dim('content:')}`);
              for (let i = 0; i < Math.min(lines.length, previewCap); i += 1) {
                stderrLine(`    ${ui.green(`+ ${lines[i]}`)}`);
              }
              if (lines.length > previewCap) {
                stderrLine(`    ${ui.dim(`... ${lines.length - previewCap} more lines ...`)}`);
              }
            } else if (event.toolName === 'apply_patch' && typeof ti.patch === 'string') {
              const lines = ti.patch.split('\n');
              stderrLine(`  ${ui.dim('patch:')}`);
              for (let i = 0; i < Math.min(lines.length, previewCap); i += 1) {
                const line = lines[i]!;
                const tone =
                  line.startsWith('+') && !line.startsWith('+++')
                    ? ui.green
                    : line.startsWith('-') && !line.startsWith('---')
                      ? ui.red
                      : ui.dim;
                stderrLine(`    ${tone(line)}`);
              }
              if (lines.length > previewCap) {
                stderrLine(`    ${ui.dim(`... ${lines.length - previewCap} more lines ...`)}`);
              }
            } else if (event.toolName === 'multi_edit' && Array.isArray(ti.edits)) {
              const edits = ti.edits as Array<Record<string, unknown>>;
              stderrLine(`  ${ui.dim(`edits (${edits.length} file(s)):`)}`);
              for (let i = 0; i < Math.min(edits.length, isVerbose ? 12 : 6); i += 1) {
                const e = edits[i] ?? {};
                const p = typeof e.path === 'string' ? e.path : `edit[${i}]`;
                stderrLine(`    ${ui.bold(p)}`);
                if (typeof e.old_string === 'string' && typeof e.new_string === 'string') {
                  const diff = diffLinesForApproval(e.old_string, e.new_string);
                  if (diff) {
                    for (const line of diff.slice(0, isVerbose ? 16 : 8)) {
                      const tone = line.startsWith('- ') ? ui.red : line.startsWith('+ ') ? ui.green : ui.dim;
                      stderrLine(`      ${tone(line)}`);
                    }
                  }
                }
              }
              if (edits.length > (isVerbose ? 12 : 6)) {
                stderrLine(`    ${ui.dim(`... ${edits.length - (isVerbose ? 12 : 6)} more file(s) ...`)}`);
              }
            } else if (
              event.toolName === 'move_file'
              && typeof ti.source === 'string'
              && typeof ti.destination === 'string'
            ) {
              stderrLine(`  ${ui.red(ti.source)} ${ui.dim('→')} ${ui.green(ti.destination)}`);
            }
          }

          if (isVerbose && event.result) {
            const lines = String(event.result).split('\n');
            if (lines.length > 0) {
              stderrLine(`  ${ui.dim('output:')}`);
              for (let i = 0; i < Math.min(lines.length, MAX_DETAIL_LINES); i += 1) {
                stderrLine(`    ${lines[i]}`);
              }
              if (lines.length > MAX_DETAIL_LINES) {
                stderrLine(`    ${ui.dim(`... ${lines.length - MAX_DETAIL_LINES} more lines ...`)}`);
              }
            }
          }
          // Artifact hint: when write_file/edit_file creates an HTML/SVG file,
          // surface a "open in browser" hint so headless/oneshot users know they
          // can view the rendered artifact (parity with the TUI artifact hint).
          if (
            !event.isError &&
            !event.aborted &&
            (event.toolName === 'write_file' || event.toolName === 'edit_file') &&
            toolInput && typeof toolInput === 'object'
          ) {
            const pathVal = (toolInput as { path?: unknown }).path;
            if (typeof pathVal === 'string' && /\.(html?|svg)$/i.test(pathVal)) {
              stderrLine(`  ${ui.dim('🔗')} ${pathVal} ${ui.dim('— open in browser')}`);
            }
          }
        }
        break;
      }
      case 'compaction':
        spinner?.stop();
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(
            `${mark()} context ${ui.dim(`compacted ${event.droppedMessages} messages into ${event.summaryChars} chars`)}`
          );
        }
        break;
      case 'working_context_checkpoint':
        if (!isQuiet) {
          // A `paused_resumable` checkpoint at normal run-end (reason
          // 'agent_loop_done') is a STALE residue of a mid-run tool error the
          // model already handled and answered — showing "⚠️ 任务暂停" after
          // the user can see the answer is misleading (the run ended normally;
          // the checkpoint is saved silently for resume). Suppress it.
          // Likewise 'tool_loop_guard' — the guard routinely short-circuits
          // redundant tool calls and the model continues; it's an internal
          // optimization, not a real pause the user needs to see.
          // 'max_turns' still surfaces — that's a genuine pause the user can
          // resume from. 'compaction' is a routine context-management operation
          // (the user sees the compaction summary via the separate 'compaction'
          // event), not a pause.
          if (event.reason === 'agent_loop_done' || event.reason === 'tool_loop_guard' || event.reason === 'compaction') break;
          breakAnswerForStatus();

          const statusMap: Record<string, string> = {
            paused_resumable: '⚠️ 任务暂停（可恢复）',
            paused: '⚠️ 任务暂停',
            in_progress: '🔄 进行中',
            completed: '✅ 已完成',
          };
          const statusText = statusMap[event.status] || event.status;



          stderrLine(`${mark()} ${statusText}`);
        }
        break;
      case 'microcompact':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(
            `${mark()} context ${ui.dim(`compressed ${event.compressedCount} items, saved ~${event.savedTokens} tokens`)}`
          );
        }
        break;
      case 'turn_end':
        if (!isQuiet && isVerbose) {
          breakAnswerForStatus();
          const tools = event.totalToolCalls ? `, tools=${event.totalToolCalls}` : '';
          stderrLine(
            `${mark('ok')} turn ${event.turn} ${ui.dim(`finished: ${event.stopReason}${tools}`)}`
          );
        }
        break;
      case 'retry': {
        // Clear partial buffered answer text from the failed attempt so the
        // new attempt's deltas don't append to garbled/duplicate output.
        // (Parity with TUI's retry handler which resets the transcript entry.)
        state.answerBuffer = '';
        state.answerLive = false;
        state.answerOpen = false;
        state.answerStarted = false;
        if (!isQuiet) {
          spinner?.stop();
          stderrLine(ui.dim(`retrying (attempt ${(event as { attempt: number }).attempt})…`));
        }
        break;
      }
      case 'error':
        spinner?.stop();
        breakAnswerForStatus();
        stderrLine(
          `${mark('fail')} error ${event.retriable ? 'retryable ' : ''}${summarizeForCli(event.error, 400)}`
        );
        break;
      case 'done': {
        spinner?.stop();
        if (state.thinkingOpen) {
          stderr.write('\n');
          state.thinkingOpen = false;
        }
        if (state.answerOpen) {
          // Flush buffered answer text with full markdown rendering before closing.
          flushAnswerBuffer();
          stdout.write('\n');
          state.answerOpen = false;
        }
        // Reset answerStarted so a renderer reused across runs doesn't insert
        // a spurious blank line before the first text of the next run.
        state.answerStarted = false;
        
        
        
        const stopReason = event.result?.stopReason;
        if (stopReason === 'max_turns_reached' || stopReason === 'tool_followup_cap_reached') {
          stderrLine(
            `${mark('fail')} stopped at the turn limit before finishing — the task is paused, not complete. Continue with ${ui.bold('moss resume --last')} (or ${ui.bold('moss --continue')}).`
          );
        } else if (!isQuiet && state.editedJsTs && !state.ranTests) {
          // Only suggest npm test when JS/TS files were edited — avoid false
          // positives when the agent only writes Python, docs, or other files.
          const testCmd = discoverableTestCommand(options.workspaceDir);
          if (testCmd) {
            stderrLine(
              `${mark()} note: edited JS/TS files but did not run the project's tests — run ${ui.bold(testCmd)} to confirm the change works.`
            );
          }
        }
        break;
      }
    }
  }

  return {
    detailMode,
    handle,
    dispose: () => {
      try {
        unsubscribeBackground();
      } catch {
        /* ignore */
      }
    },
  };
}
