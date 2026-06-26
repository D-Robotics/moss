import fs from 'node:fs';
import path from 'node:path';
import type { MossAgentEvent } from '../core/index.js';
import { redactSensitiveData } from '../observability/redact.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { ui } from './ui.js';

/** Tool names that mutate files in the workspace. */
const CODE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'move_file']);
/** Shell commands that count as "ran the project's tests/build". */
const TEST_COMMAND_RE =
  /\b(npm (run )?test|npm t|yarn test|pnpm test|node\s+--test|pytest|vitest|jest|mocha|go test|cargo test|make test|npm run (build|typecheck|lint)|tsc)\b/;

/**
 * The project's test command if the workspace declares one, else null. Used to
 * nudge after code edits that weren't verified. Conservative on purpose: only
 * a real package.json "test" script counts (skips the npm "no test specified"
 * default), so the nudge has near-zero false positives.
 */
function discoverableTestCommand(workspaceDir: string | undefined): string | null {
  if (!workspaceDir) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
    const test = pkg?.scripts?.test;
    if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
      return 'npm test';
    }
  } catch {
    /* no package.json / unreadable → no nudge */
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
  /** Workspace dir — enables the "edited code but didn't run tests" nudge. */
  workspaceDir?: string;
}

interface RendererState {
  answerOpen: boolean;
  /** True once ANY answer text has been written — distinguishes the first answer
   * segment (no leading separator) from a later one resumed after a tool call. */
  answerStarted: boolean;
  thinkingOpen: boolean;
  thinkingNoted: boolean;
  toolStartTimes: Map<string, number>;
  /** Verification nudge bookkeeping: did this run edit code, and did it run tests? */
  editedCode: boolean;
  ranTests: boolean;
}

/**
 * D-Robotics Moss branded spinner animation.
 * The orange prompt chevron stays anchored while the cyan cursor block
 * scans right and back — a compact "breathing" brand mark for loading states.
 *
 * Brand mark: ❯▪  (BRAND_ORANGE prompt + BRAND_CYAN cursor)
 *
 * Frame sequence:
 *   Moss ❯▪      → cursor right at prompt
 *   Moss ❯ ▪     → slight separation
 *   Moss ❯  ▪    → wider
 *   Moss ❯   ▪   → max gap (scanning away)
 *   Moss ❯  ▪    → closing
 *   Moss ❯ ▪     → nearly reconnected
 */
const SPINNER_FRAMES = [
  'Moss ❯▪',
  'Moss ❯ ▪',
  'Moss ❯  ▪',
  'Moss ❯   ▪',
  'Moss ❯  ▪',
  'Moss ❯ ▪',
];

class CliSpinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(private readonly stderr: Pick<NodeJS.WriteStream, 'write'>) {}

  start(label: string): void {
    if (this.active) return;
    this.active = true;
    this.frame = 0;
    this.timer = setInterval(() => {
      // \r returns to column 0; \x1b[K erases to end-of-line so that a
      // shorter frame doesn't leave ghost characters from the previous
      // (wider) frame. The brand-mark frames vary in width (the cursor
      // block scans), so clearing each tick is mandatory.
      this.stderr.write(`\r\x1b[K${SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]} ${label}`);
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
    // Clear the spinner line
    this.stderr.write('\r\x1b[K');
  }
}

export function resolveCliDetailMode(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CliDetailMode {
  const raw = (env.MOSS_CLI_DETAIL || '').toLowerCase();
  if (argv.includes('--quiet') || raw === 'quiet' || raw === 'off' || raw === 'none') return 'quiet';

  // --json, --output-format json/stream-json imply structured machine output → quiet
  const hasJsonOutputFormat =
    argv.includes('--json') ||
    argv.some((a) => a.startsWith('--output-format=json') || a.startsWith('--output-format=stream-json')) ||
    (argv.includes('--output-format') &&
      argv.some((a, i) =>
        i > 0 && argv[i - 1] === '--output-format' && (a === 'json' || a === 'stream-json'),
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
  // Verbose tool-I/O previews go to stderr for the developer to READ. Keep all
  // SECRET scrubbing (sensitive field names, IPs, credential-bearing URLs via
  // redactSensitiveData; inline key patterns via sanitizeSecrets) but SKIP the
  // ">200-char looks-like-file-contents" heuristic — that one collapsed every
  // multi-line read_file / web result to "[REDACTED]", gutting verbose's purpose.
  const redacted = redactSensitiveData(value, { skipFileContentHeuristic: true });
  const raw =
    typeof redacted === 'string'
      ? redacted
      : JSON.stringify(redacted, null, 0) ?? String(redacted);
  const oneLine = sanitizeSecrets(raw)
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function progressToolLabel(toolName: string): string {
  if (toolName === 'read_file') return 'reading file';
  if (
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'move_file' ||
    toolName === 'apply_patch'
  ) {
    return 'updating file';
  }
  if (toolName === 'search_code' || toolName === 'search_files' || toolName === 'list_directory') {
    return 'searching';
  }
  if (toolName === 'exec' || toolName === 'exec_background') return 'running command';
  if (toolName.startsWith('device_') || toolName.startsWith('ros2_')) return 'device command';
  if (toolName.startsWith('web_search')) return 'searching web';
  if (toolName.startsWith('web_fetch')) return 'fetching web page';
  if (toolName.startsWith('memory_read')) return 'reading memory';
  if (toolName.startsWith('memory_write')) return 'writing memory';
  if (toolName.startsWith('memory_delete')) return 'deleting memory';
  if (toolName.includes('subagent')) return 'subagent task';
  if (toolName.startsWith('browser_')) return 'browser operation';
  return 'working';
}

/**
 * 从工具输入中提取简短的操作目标信息，用于非 verbose 模式下显示。
 * 例如：read_file 的 path 参数 → "hello.ts"
 *       exec 的 command 参数 → "npm test"
 */
function extractToolTarget(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const truncate = (s: string, max = 60): string =>
    s.length <= max ? s : `${s.slice(0, max - 1)}…`;

  // 文件相关工具：显示文件名
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file' || toolName === 'move_file') {
    const p = obj.path ?? obj.filePath;
    if (typeof p === 'string') return truncate(path.basename(p));
    return '';
  }
  if (toolName === 'apply_patch') {
    const p = obj.path ?? obj.filePath;
    if (typeof p === 'string') return truncate(path.basename(p));
    return '';
  }
  // 搜索工具：显示 pattern
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
  // 命令执行：显示命令
  if (toolName === 'exec' || toolName === 'exec_background') {
    const cmd = obj.command;
    if (typeof cmd === 'string') return truncate(cmd);
    return '';
  }
  // Web 搜索：显示查询
  if (toolName.startsWith('web_search')) {
    const q = obj.query ?? obj.question;
    if (typeof q === 'string') return truncate(q, 40);
    return '';
  }
  // Web 页面抓取：显示 URL
  if (toolName.startsWith('web_fetch')) {
    const url = obj.url;
    if (typeof url === 'string') return truncate(url, 60);
    return '';
  }
  // 记忆操作：显示 key 或 query
  if (toolName.startsWith('memory_read') || toolName.startsWith('memory_write')) {
    const key = obj.key ?? obj.query;
    if (typeof key === 'string') return truncate(key, 40);
    return '';
  }
  // 浏览器操作：显示 url 或 action
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
    editedCode: false,
    ranTests: false,
    thinkingOpen: false,
    thinkingNoted: false,
    toolStartTimes: new Map(),
  };

  const isQuiet = detailMode === 'quiet';
  const isVerbose = detailMode === 'verbose';

  function mark(kind: 'info' | 'ok' | 'fail' = 'info'): string {
    if (!interactive) {
      if (kind === 'ok') return 'ok';
      if (kind === 'fail') return 'err';
      return '-';
    }
    if (kind === 'ok') return ui.green('✓');
    if (kind === 'fail') return ui.yellow('!');
    return ui.cyan('•');
  }

  function stderrLine(line: string): void {
    stderr.write(`${line}\n`);
  }

  function breakAnswerForStatus(): void {
    if (state.answerOpen) {
      stderr.write('\n');
      state.answerOpen = false;
    }
    if (state.thinkingOpen) {
      stderr.write('\n');
      state.thinkingOpen = false;
    }
  }

  function handle(event: MossAgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        if (!isQuiet) {
          breakAnswerForStatus();
          spinner?.stop();
          if (isVerbose) {
            stderrLine(`${mark()} thinking${ui.dim(` (turn ${event.turn})`)}`);
          } else if (interactive) {
            spinner?.start(`working...${event.turn > 1 ? ` (turn ${event.turn})` : ''}`);
          } else {
            stderrLine(`${mark()} thinking turn ${event.turn}`);
          }
          state.thinkingNoted = true;
        }
        break;
      case 'thinking_delta':
        if (isQuiet) break;
        breakAnswerForStatus();
        if (isVerbose && process.env.MOSS_SHOW_THINKING === 'true') {
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
        // A new answer segment resumed after a tool call / turn break: separate
        // it from the previous segment on stdout so the answer isn't a run-on
        // wall ("…running it.The crash is…"). First segment gets no separator.
        if (!state.answerOpen && state.answerStarted) {
          stdout.write('\n\n');
        }
        stdout.write(event.delta);
        state.answerOpen = true;
        state.answerStarted = true;
        break;
      case 'tool_start': {
        spinner?.stop();
        state.toolStartTimes.set(event.toolCallId, Date.now());
        // Track (in every mode) whether this run edits code and whether it runs
        // the project's tests/build — drives the end-of-run verification nudge.
        if (CODE_EDIT_TOOLS.has(event.toolName)) state.editedCode = true;
        if (event.toolName === 'exec' || event.toolName === 'device_exec') {
          const cmd = (event.input as { command?: unknown } | undefined)?.command;
          if (typeof cmd === 'string' && TEST_COMMAND_RE.test(cmd)) state.ranTests = true;
        }
        if (!isQuiet) {
          breakAnswerForStatus();
          if (isVerbose) {
            const input = summarizeForCli(event.input);
            stderrLine(input ? `${mark()} ${ui.bold(event.toolName)} ${ui.dim('input')} ${input}` : `${mark()} ${ui.bold(event.toolName)} ${ui.dim('running')}`);
          } else {
            // 提取简短的操作目标信息，让用户知道在操作什么
            const target = extractToolTarget(event.toolName, event.input);
            stderrLine(target
              ? `${mark()} ${progressToolLabel(event.toolName)} ${ui.dim(target)}`
              : `${mark()} ${progressToolLabel(event.toolName)} ${ui.dim('running')}`);
          }
        }
        break;
      }
      case 'tool_end':
        if (!isQuiet) {
          breakAnswerForStatus();
          const startedAt = state.toolStartTimes.get(event.toolCallId);
          state.toolStartTimes.delete(event.toolCallId);
          const elapsed = startedAt ? ` ${Date.now() - startedAt}ms` : '';
          const statusText = event.aborted
            ? `aborted (${event.aborted.by})`
            : event.isError
              ? 'failed'
              : 'ok';
          const statusKind = event.isError || event.aborted ? 'fail' : 'ok';
          
          // 改进错误信息展示：提取更友好的错误消息
          const formatErrorResult = (result: unknown): string => {
            if (!result) return '';
            if (typeof result === 'string') {
              // 尝试提取友好的错误消息
              // 例如："Execution error: Error reading file: ENOENT: ..." -> "文件不存在"
              if (result.includes('ENOENT')) return '文件不存在';
              if (result.includes('EACCES')) return '权限不足';
              if (result.includes('EISDIR')) return '目标是一个目录';
              // 否则，截断过长的内容
              const cleaned = result.replace(/Execution error:\s*/i, '').trim();
              return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
            }
            // 如果是对象，尝试提取 error 或 message 字段
            if (typeof result === 'object' && result !== null) {
              const obj = result as Record<string, unknown>;
              if (obj.error) return String(obj.error);
              if (obj.message) return String(obj.message);
            }
            return summarizeForCli(result, 200);
          };
          
          if (isVerbose) {
            const result = summarizeForCli(event.result);
            stderrLine(result ? `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}${elapsed}: ${result}` : `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}${elapsed}`);
          } else {
            const failReason = event.isError ? formatErrorResult(event.result) : '';
            stderrLine(
              failReason
                  ? `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}: ${failReason}`
                  : `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}${elapsed}`,
            );
          }
        }
        break;
      case 'compaction':
        spinner?.stop();
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`${mark()} context ${ui.dim(`compacted ${event.droppedMessages} messages into ${event.summaryChars} chars`)}`);
        }
        break;
      case 'working_context_checkpoint':
        if (!isQuiet) {
          breakAnswerForStatus();
          // 改进上下文暂停消息的用户友好性
          const statusMap: Record<string, string> = {
            'paused_resumable': '⚠️ 任务暂停（可恢复）',
            'paused': '⚠️ 任务暂停',
            'in_progress': '🔄 进行中',
            'completed': '✅ 已完成',
          };
          const statusText = statusMap[event.status] || event.status;
          
          // 不显示 nextAction，因为它通常是给 LLM 的技术指导，对用户不友好
          // 只显示状态，让用户看 moss 的自然语言回复即可
          stderrLine(`${mark()} ${statusText}`);
        }
        break;
      case 'microcompact':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`${mark()} context ${ui.dim(`compressed ${event.compressedCount} items, saved ~${event.savedTokens} tokens`)}`);
        }
        break;
      case 'turn_end':
        if (!isQuiet && isVerbose) {
          breakAnswerForStatus();
          const tools = event.totalToolCalls ? `, tools=${event.totalToolCalls}` : '';
          stderrLine(`${mark('ok')} turn ${event.turn} ${ui.dim(`finished: ${event.stopReason}${tools}`)}`);
        }
        break;
      case 'error':
        spinner?.stop();
        breakAnswerForStatus();
        stderrLine(`${mark('fail')} error ${event.retriable ? 'retryable ' : ''}${summarizeForCli(event.error, 400)}`);
        break;
      case 'done': {
        spinner?.stop();
        if (state.thinkingOpen) {
          stderr.write('\n');
          state.thinkingOpen = false;
        }
        if (state.answerOpen) {
          stdout.write('\n');
          state.answerOpen = false;
        }
        // Long-horizon continuity: a run stopped by the turn cap is TRUNCATED,
        // not finished — always surface, even in quiet mode (it is a hard stop,
        // not progress noise).
        const stopReason = event.result?.stopReason;
        if (stopReason === 'max_turns_reached' || stopReason === 'tool_followup_cap_reached') {
          stderrLine(
            `${mark('fail')} stopped at the turn limit before finishing — the task is paused, not complete. Continue with ${ui.bold('moss resume --last')} (or ${ui.bold('moss --continue')}).`,
          );
        } else if (!isQuiet && state.editedCode && !state.ranTests) {
          // Embody moss's "no success without a verified outcome" rule at the CLI
          // edge: if the run changed files but never ran the project's tests, say
          // so once. High-precision gate (a real package.json test script) keeps
          // this from firing on doc/config-only edits.
          const testCmd = discoverableTestCommand(options.workspaceDir);
          if (testCmd) {
            stderrLine(
              `${mark()} note: edited files but did not run the project's tests — run ${ui.bold(testCmd)} to confirm the change works.`,
            );
          }
        }
        break;
      }
    }
  }

  return { detailMode, handle };
}
