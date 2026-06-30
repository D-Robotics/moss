import fs from 'node:fs';
import path from 'node:path';
import type { MossAgentEvent } from '../core/index.js';
import { redactSensitiveData } from '../observability/redact.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { ui } from './ui.js';


const CODE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'move_file']);

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
  
  editedCode: boolean;
  ranTests: boolean;
}
















const SPINNER_FRAMES = ['Moss ❯▪', 'Moss ❯ ▪', 'Moss ❯  ▪', 'Moss ❯   ▪', 'Moss ❯  ▪', 'Moss ❯ ▪'];

/** verbose 模式下 tool_end 输出最多展示的行数，超出部分以 "... N more lines ..." 折叠。 */
const MAX_DETAIL_LINES = 200;

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

function extractToolCommand(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  if (EXEC_LIKE_TOOLS.has(toolName) && typeof obj.command === 'string') return obj.command;
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
  if (toolName === 'exec_logs') return 'viewing logs';
  if (toolName === 'exec_stop') return 'stopping process';
  if (toolName.startsWith('device_') || toolName.startsWith('ros2_')) return 'device command';
  if (toolName.startsWith('web_search')) return 'searching web';
  if (toolName.startsWith('web_fetch')) return 'fetching web page';
  if (toolName === 'web_browser_agent' || toolName === 'web_browser_control' || toolName === 'web_browser_fetch') return 'browser operation';
  if (toolName.startsWith('memory_read')) return 'reading memory';
  if (toolName.startsWith('memory_write')) return 'writing memory';
  if (toolName.startsWith('memory_delete')) return 'deleting memory';
  if (toolName === 'vision_analyze') return 'analyzing image';
  if (toolName === 'screenshot_capture') return 'capturing screenshot';
  if (toolName === 'code_diagnostics') return 'code analysis';
  if (toolName === 'plan') return 'plan management';
  if (toolName === 'plan_step') return 'updating plan';
  if (toolName === 'eval') return 'evaluation';
  if (toolName === 'generate_structured') return 'structured output';
  if (toolName === 'fleet_batch') return 'batch device operation';
  if (toolName === 'install_skill') return 'installing skill';
  if (toolName.includes('subagent')) return 'subagent task';
  if (toolName.startsWith('browser_')) return 'browser operation';
  return 'working';
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
    const p = obj.path ?? obj.filePath;
    if (typeof p === 'string') return truncate(path.basename(p));
    return '';
  }
  if (toolName === 'apply_patch') {
    const p = obj.path ?? obj.filePath;
    if (typeof p === 'string') return truncate(path.basename(p));
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

  if (toolName === 'code_diagnostics') {
    const cmd = obj.command;
    if (typeof cmd === 'string') return truncate(cmd, 40);
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
    editedCode: false,
    ranTests: false,
    thinkingOpen: false,
    thinkingNoted: false,
    toolStartTimes: new Map(),
    toolInputs: new Map(),
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
        state.toolInputs.set(event.toolCallId, event.input);
        
        
        if (CODE_EDIT_TOOLS.has(event.toolName)) state.editedCode = true;
        if (event.toolName === 'exec' || event.toolName === 'device_exec') {
          const cmd = (event.input as { command?: unknown } | undefined)?.command;
          if (typeof cmd === 'string' && TEST_COMMAND_RE.test(cmd)) state.ranTests = true;
        }
        if (!isQuiet) {
          breakAnswerForStatus();
          if (isVerbose) {
            const input = summarizeForCli(event.input);
            stderrLine(
              input
                ? `${mark()} ${ui.bold(event.toolName)} ${ui.dim('input')} ${input}`
                : `${mark()} ${ui.bold(event.toolName)} ${ui.dim('running')}`
            );
            const fullCommand = extractToolCommand(event.toolName, event.input);
            if (fullCommand) stderrLine(`  ${ui.dim('command:')} ${fullCommand}`);
          } else {
            
            const target = extractToolTarget(event.toolName, event.input);
            stderrLine(
              target
                ? `${mark()} ${progressToolLabel(event.toolName)} ${ui.dim(target)}`
                : `${mark()} ${progressToolLabel(event.toolName)} ${ui.dim('running')}`
            );
          }
        }
        break;
      }
      case 'tool_end':
        if (!isQuiet) {
          breakAnswerForStatus();
          const startedAt = state.toolStartTimes.get(event.toolCallId);
          state.toolStartTimes.delete(event.toolCallId);
          const toolInput = state.toolInputs.get(event.toolCallId);
          state.toolInputs.delete(event.toolCallId);
          const elapsed = startedAt ? ` ${Date.now() - startedAt}ms` : '';
          const statusText = event.aborted
            ? `aborted (${event.aborted.by})`
            : event.isError
              ? 'failed'
              : 'ok';
          const statusKind = event.isError || event.aborted ? 'fail' : 'ok';

          if (isVerbose) {
            const resultSummary = summarizeForCli(event.result);
            stderrLine(
              resultSummary
                ? `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}${elapsed}: ${resultSummary}`
                : `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}${elapsed}`
            );
            const fullCommand = extractToolCommand(event.toolName, toolInput);
            if (fullCommand) stderrLine(`  ${ui.dim('command:')} ${fullCommand}`);
            const exitCode = extractExecExitCode(event.toolName, event.result);
            if (exitCode !== undefined) stderrLine(`  ${ui.dim('exit code:')} ${exitCode}`);
            if (event.result) {
              const lines = String(event.result).split('\n');
              if (lines.length > 0) {
                stderrLine(`  ${ui.dim('output:')}`);
                for (let i = 0; i < Math.min(lines.length, MAX_DETAIL_LINES); i += 1) {
                  stderrLine(`    ${lines[i]}`);
                }
                if (lines.length > MAX_DETAIL_LINES) {
                  stderrLine(
                    `    ${ui.dim(`... ${lines.length - MAX_DETAIL_LINES} more lines ...`)}`
                  );
                }
              }
            }
          } else {
            const failReason = event.isError ? formatErrorResult(event.result) : '';
            stderrLine(
              failReason
                ? `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}: ${failReason}`
                : `${mark(statusKind)} ${progressToolLabel(event.toolName)} ${statusText}${elapsed}`
            );
          }
        }
        break;
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
          stdout.write('\n');
          state.answerOpen = false;
        }
        
        
        
        const stopReason = event.result?.stopReason;
        if (stopReason === 'max_turns_reached' || stopReason === 'tool_followup_cap_reached') {
          stderrLine(
            `${mark('fail')} stopped at the turn limit before finishing — the task is paused, not complete. Continue with ${ui.bold('moss resume --last')} (or ${ui.bold('moss --continue')}).`
          );
        } else if (!isQuiet && state.editedCode && !state.ranTests) {
          
          
          
          
          const testCmd = discoverableTestCommand(options.workspaceDir);
          if (testCmd) {
            stderrLine(
              `${mark()} note: edited files but did not run the project's tests — run ${ui.bold(testCmd)} to confirm the change works.`
            );
          }
        }
        break;
      }
    }
  }

  return { detailMode, handle };
}
