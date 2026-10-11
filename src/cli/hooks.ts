import type { ToolApprovalRequest, ToolApprovalDecision } from '../core/agent/agent-hooks.js';
import type { ToolCall, ToolResult } from '../core/tools/tool-types.js';
import type { HooksConfig, HookCommandConfig } from './config.js';
import { claudeToolInput, claudeToolName, hookMatcherMatches } from './claude-compat.js';
import { redactEgress } from '../safety/tool-output-redact.js';
import { CompactHookRegistry } from '../core/loop/compact-hooks.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { errorMessage } from '../errors.js';
import { ProcessError, runProcess } from '../utils/run-process.js';
import { isZhLocale } from './cli-locale.js';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * O90: Node's `setTimeout` ceiling. A larger delay overflows the timer and
 * fires almost immediately, so a hook with `timeoutMs` above this would be
 * reported as timed out at once. Clamp the effective timeout to this value.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647; // 2^31 - 1

/** Hook configs whose oversized timeoutMs has already been warned about. */
const warnedClampedTimeouts = new WeakSet<HookCommandConfig>();

/**
 * Shell invocation for a user hook command.
 *
 * On Windows, Node's default spawn quoting escapes embedded `"` as `\"`.
 * `cmd.exe` does not treat that backslash as an escape, so a command such as
 * `"C:\node.exe" "C:\x\dump.mjs"` never starts. Match `child_process.exec`:
 * wrap the command in one extra pair of quotes, pass `/s` so cmd strips only
 * that wrapper, and set `windowsVerbatimArguments` so the quotes stay quotes.
 * POSIX stays `/bin/sh -c` with the command unchanged.
 */
export function hookShell(
  command: string,
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32') {
    return {
      cmd: process.env.COMSPEC || 'cmd.exe',
      // cmd /c normalizes an unknown command's ERRORLEVEL 9009 to exit 1.
      // Exit explicitly with the current ERRORLEVEL so a missing hook cannot
      // impersonate the non-blocking Claude exit-1 verdict. Explicit user
      // exit commands still terminate before this suffix.
      args: ['/d', '/s', '/c', `"${command} & exit /b"`],
      windowsVerbatimArguments: true,
    };
  }
  return { cmd: '/bin/sh', args: ['-c', command] };
}

/**
 * O88: how the hook process ended. `spawn_failed` and `timeout` mean the hook
 * never gave a verdict — blocking events fail closed on them.
 */
type HookOutcome = 'exit' | 'spawn_failed' | 'timeout';

/** Shell exit codes meaning "command not found / not executable". */
const LAUNCH_FAILURE_EXIT_CODES =
  process.platform === 'win32' ? new Set([9009]) : new Set([126, 127]);

interface HookRunResult {
  outcome: HookOutcome;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface HookPayload {
  event:
    | 'PreToolUse'
    | 'PostToolUse'
    | 'UserPromptSubmit'
    | 'PermissionRequest'
    | 'SessionStart'
    | 'Stop'
    | 'SubagentStop'
    | 'PreCompact'
    | 'PostCompact'
    | 'SessionEnd'
    | 'Notification';
  toolName?: string;
  /** Claude-format alias of toolName (Bash, Edit, …). */
  tool_name?: string;
  input?: Record<string, unknown>;
  /** Claude-format alias of input. */
  tool_input?: Record<string, unknown>;
  /** UserPromptSubmit: the submitted prompt. */
  prompt?: string;
  result?: string;
  isError?: boolean;
  /** Stop hook: the run's stop subtype (e.g. end_turn, error_budget_exceeded). */
  stopReason?: string;
  /** Stop hook: tail of the final response. */
  response?: string;
  /** SubagentStop hook fields. */
  goal?: string;
  success?: boolean;
  summary?: string;
  /** Compact hook fields. */
  compactReason?: string;
  summaryChars?: number;
  droppedMessages?: number;
  /** Notification hook fields. */
  notificationReason?: string;
  message?: string;
}

function runHookCommand(
  command: string,
  payload: HookPayload,
  cwd: string,
  timeoutMs: number
): Promise<HookRunResult> {
  const shell = hookShell(command);
  const env = safeChildEnv({
    LANG: process.env.LANG || 'en_US.UTF-8',
    MOSS_HOOK_EVENT: payload.event,
    MOSS_TOOL_NAME: payload.toolName ?? '',
    MOSS_WORKSPACE: cwd,
  });
  return runProcess(shell.cmd, {
    args: shell.args,
    cwd,
    env,
    timeout: timeoutMs,
    stdin: JSON.stringify(payload),
    ...(shell.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
    .then(
      ({ exitCode, stdout, stderr }): HookRunResult => ({
        outcome: LAUNCH_FAILURE_EXIT_CODES.has(exitCode) ? 'spawn_failed' : 'exit',
        exitCode,
        stdout,
        stderr,
      })
    )
    .catch((err): HookRunResult => {
      if (err instanceof ProcessError) {
        if (err.timedOut) {
          return {
            outcome: 'timeout',
            exitCode: 124,
            stdout: err.stdout,
            stderr: `${err.stderr}\n[hook timed out after ${timeoutMs}ms]`,
          };
        }
        if (err.exitCode === null && err.signal === null) {
          return { outcome: 'spawn_failed', exitCode: 1, stdout: err.stdout, stderr: err.stderr };
        }
        const code = err.exitCode ?? 1;
        return {
          outcome: LAUNCH_FAILURE_EXIT_CODES.has(code) ? 'spawn_failed' : 'exit',
          exitCode: code,
          stdout: err.stdout,
          stderr: err.stderr,
        };
      }
      return { outcome: 'spawn_failed', exitCode: 1, stdout: '', stderr: errorMessage(err) };
    });
}

function toolNameMatches(hook: HookCommandConfig, toolName: string): boolean {
  return hookMatcherMatches(hook.matcher, toolName, hook.format === 'claude');
}

function claudePayload(
  hook: HookCommandConfig,
  toolName: string | undefined,
  input: Record<string, unknown> | undefined
): Pick<HookPayload, 'tool_name' | 'tool_input'> {
  if (hook.format !== 'claude' || !toolName) return {};
  return {
    tool_name: claudeToolName(toolName),
    ...(input ? { tool_input: claudeToolInput(toolName, input) } : {}),
  };
}

interface ParsedHookJson {
  decision?: string;
  reason?: string;
  additionalContext?: string;
}

function parseHookJson(stdout: string): ParsedHookJson | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const last = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  const candidates = last && last !== text ? [text, last] : [text];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      let decision = typeof record.decision === 'string' ? record.decision : undefined;
      let reason = typeof record.reason === 'string' ? record.reason : undefined;
      let additionalContext =
        typeof record.additionalContext === 'string' ? record.additionalContext : undefined;
      const specific = record.hookSpecificOutput;
      if (specific && typeof specific === 'object' && !Array.isArray(specific)) {
        const spec = specific as Record<string, unknown>;
        if (typeof spec.additionalContext === 'string') additionalContext = spec.additionalContext;
        const nested = spec.decision;
        if (typeof nested === 'string') decision = nested;
        else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          const body = nested as Record<string, unknown>;
          if (typeof body.behavior === 'string') decision = body.behavior;
          if (typeof body.message === 'string') reason = body.message;
        }
        if (typeof spec.permissionDecision === 'string') decision = spec.permissionDecision;
        if (typeof spec.permissionDecisionReason === 'string') {
          reason = spec.permissionDecisionReason;
        }
      }
      return {
        ...(decision ? { decision } : {}),
        ...(reason ? { reason } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function exitBlocks(hook: HookCommandConfig, result: HookRunResult): boolean {
  if (hook.blocking === false) return false;
  // O88: no verdict (could not start / timed out) fails closed in both formats.
  if (result.outcome !== 'exit') return true;
  return hook.format === 'claude' ? result.exitCode === 2 : result.exitCode !== 0;
}

type HookEventName = HookPayload['event'];

/** True when the run did not end with a clean exit 0 (worth telling the user). */
function hookFailed(result: HookRunResult): boolean {
  return result.outcome !== 'exit' || result.exitCode !== 0;
}

/**
 * O88: one message for both the terminal and the model's tool result: which
 * hook, why, where it is configured, and the only two next steps.
 * zh copy keeps only the command, the path, and `blocking: false` in English.
 */
export function formatHookFailure(
  event: HookEventName,
  hook: HookCommandConfig,
  result: HookRunResult,
  blocked: boolean,
  zh = isZhLocale()
): string {
  const detail = (result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const where = hook.source ?? (zh ? '（未知配置文件）' : '(unknown config file)');
  if (zh) {
    const why =
      result.outcome === 'spawn_failed'
        ? '未能启动'
        : result.outcome === 'timeout'
          ? `超时（${timeoutFor(hook)} 毫秒）`
          : `非零退出（退出码 ${result.exitCode}）`;
    const name = event === 'PreToolUse' ? '工具调用前钩子' : `${event} 钩子`;
    const head = blocked ? `已拦截：${name}${why}。` : `${name}${why}，未拦截。`;
    const lines = [
      head,
      `命令：${hook.command}`,
      `配置文件：${where}`,
      ...(detail ? [`错误输出：${detail}`] : []),
    ];
    if (blocked) {
      lines.push(`下一步：修好这条命令；或在配置文件里给这个钩子加上 blocking: false。`);
    }
    return lines.join('\n');
  }
  const why =
    result.outcome === 'spawn_failed'
      ? 'could not start'
      : result.outcome === 'timeout'
        ? `timed out after ${timeoutFor(hook)}ms`
        : `exited with code ${result.exitCode}`;
  const head = blocked ? `Blocked: ${event} hook ${why}.` : `${event} hook ${why}; not blocking.`;
  const lines = [
    head,
    `Command: ${hook.command}`,
    `Config: ${where}`,
    ...(detail ? [`stderr: ${detail}`] : []),
  ];
  if (blocked) {
    lines.push('Next: fix the command, or set blocking: false on this hook in that config file.');
  }
  return lines.join('\n');
}

function isBlockDecision(decision: string | undefined): boolean {
  const value = decision?.trim().toLowerCase();
  return value === 'block' || value === 'deny';
}

function hookReason(result: HookRunResult, parsed?: ParsedHookJson): string {
  const fromJson = parsed?.reason?.trim();
  if (fromJson) return fromJson.slice(0, 500);
  const stderr = result.stderr.trim();
  if (stderr) return stderr.slice(0, 500);
  if (!parsed) {
    const stdout = result.stdout.trim();
    if (stdout) return stdout.slice(0, 500);
  }
  return `hook exited ${result.exitCode}`;
}

function promptBlocks(
  hook: HookCommandConfig,
  result: HookRunResult,
  parsed?: ParsedHookJson
): boolean {
  return exitBlocks(hook, result) || (hook.blocking !== false && isBlockDecision(parsed?.decision));
}

function timeoutClampedWarning(hook: HookCommandConfig, requested: number): string {
  if (isZhLocale()) {
    return `警告：钩子「${hook.command}」的超时值 ${requested} 毫秒超过系统上限，已限制为 ${MAX_TIMER_DELAY_MS} 毫秒。`;
  }
  return (
    `warning: hook "${hook.command}" timeoutMs ${requested} exceeds Node's maximum timer ` +
    `delay; clamped to ${MAX_TIMER_DELAY_MS}ms`
  );
}

function timeoutFor(hook: HookCommandConfig): number {
  const effective = Math.max(1000, Number(hook.timeoutMs) || DEFAULT_HOOK_TIMEOUT_MS);
  if (effective <= MAX_TIMER_DELAY_MS) return effective;
  if (!warnedClampedTimeouts.has(hook)) {
    warnedClampedTimeouts.add(hook);
    process.stderr.write(`[hooks] ${timeoutClampedWarning(hook, effective)}\n`);
  }
  return MAX_TIMER_DELAY_MS;
}

export interface ConfiguredHookCallbacks {
  onBeforeToolExec?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

  onToolResult?: (call: ToolCall, result: ToolResult) => void;

  runSessionStart: () => Promise<void>;

  /** Stop lifecycle hook: a blocking non-zero exit vetoes the run's stop. */
  runStop: (info: StopHookInfo) => Promise<StopHookResult>;

  runSubagentStop: (info: SubagentStopHookInfo) => Promise<void>;

  /** SessionEnd: fires once when the CLI session is shutting down. */
  runSessionEnd: (info: { reason: string }) => Promise<void>;

  /** Notification: fires when user attention is needed (approval prompt). */
  runNotification: (info: { reason: string; message: string }) => Promise<void>;

  /**
   * UserPromptSubmit: exit 2, a moss non-zero exit, or `{decision:block}`
   * rejects the prompt. Other stdout is extra context for the model.
   */
  runUserPromptSubmit: (message: string) => Promise<UserPromptSubmitResult>;

  /**
   * PermissionRequest: deny is honored. Allow is ignored so the caller still
   * asks the user.
   */
  runPermissionRequest: (info: {
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<PermissionRequestResult>;

  /**
   * PreCompact/PostCompact shell hooks wrapped in the core CompactHookRegistry,
   * ready to hand to MossAgentConfig.compactHooks.
   */
  buildCompactHookRegistry: () => CompactHookRegistry | undefined;

  hasHooks: boolean;

  /** O88: TUI mode suppresses the `[hooks]` stderr line for blocked calls. */
  setTuiMode: (on: boolean) => void;
}

/** O88: events whose block reason the TUI renders in the tool row. */
const TOOL_ROW_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'PreToolUse',
  'PermissionRequest',
]);

export function createConfiguredHookCallbacks(
  hooks: HooksConfig | undefined,
  opts: { workspaceDir: string; tuiMode?: boolean }
): ConfiguredHookCallbacks {
  const pre = hooks?.PreToolUse ?? [];
  const post = hooks?.PostToolUse ?? [];
  const userPrompt = hooks?.UserPromptSubmit ?? [];
  const permission = hooks?.PermissionRequest ?? [];
  const sessionStart = hooks?.SessionStart ?? [];
  const stop = hooks?.Stop ?? [];
  const subagentStop = hooks?.SubagentStop ?? [];
  const preCompact = hooks?.PreCompact ?? [];
  const postCompact = hooks?.PostCompact ?? [];
  const sessionEnd = hooks?.SessionEnd ?? [];
  const notification = hooks?.Notification ?? [];
  const cwd = opts.workspaceDir;

  // O88: one terminal notice per (event, hook, kind) per user turn; repeats
  // within the turn are folded into the first. The tool result always carries
  // the full reason.
  const noticed = new Set<string>();
  let tuiMode = opts.tuiMode === true;
  const notice = (
    event: HookEventName,
    hook: HookCommandConfig,
    r: HookRunResult,
    blocked: boolean
  ): string => {
    const text = formatHookFailure(event, hook, r, blocked);
    const key = `${event}\u0000${hook.command}\u0000${r.outcome}\u0000${r.exitCode}\u0000${blocked}`;
    // In the TUI a blocked call's reason is already in the tool row (and the
    // stderr line would land on top of the status bar), so only headless /
    // piped runs print it.
    if (blocked && tuiMode && TOOL_ROW_EVENTS.has(event)) return text;
    if (!noticed.has(key)) {
      noticed.add(key);
      process.stderr.write(`[hooks] ${text}\n`);
    }
    return text;
  };
  /** Reason handed back to the model/caller when a blocking event is vetoed. */
  const blockReason = (
    event: HookEventName,
    hook: HookCommandConfig,
    r: HookRunResult,
    parsed?: ParsedHookJson
  ): string =>
    r.outcome !== 'exit'
      ? notice(event, hook, r, true)
      : `Blocked by ${event} hook: ${hookReason(r, parsed)}`;

  const onBeforeToolExec =
    pre.length === 0
      ? undefined
      : async (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
          for (const hook of pre) {
            if (!toolNameMatches(hook, request.tool.name)) continue;
            const r = await runHookCommand(
              hook.command,
              {
                event: 'PreToolUse',
                toolName: request.tool.name,
                input: request.input,
                ...claudePayload(hook, request.tool.name, request.input),
              },
              cwd,
              timeoutFor(hook)
            );
            const parsed = parseHookJson(r.stdout);
            if (promptBlocks(hook, r, parsed)) {
              return { approved: false, reason: blockReason('PreToolUse', hook, r, parsed) };
            }
            if (hookFailed(r)) notice('PreToolUse', hook, r, false);
          }
          return { approved: true };
        };

  const onToolResult =
    post.length === 0
      ? undefined
      : (call: ToolCall, result: ToolResult): void => {
          for (const hook of post) {
            if (!toolNameMatches(hook, call.name)) continue;
            void runHookCommand(
              hook.command,
              {
                event: 'PostToolUse',
                toolName: call.name,
                input: call.input,
                result: result.content,
                isError: Boolean(result.isError),
              },
              cwd,
              timeoutFor(hook)
            )
              .then((r) => {
                if (r.exitCode !== 0) {
                  process.stderr.write(
                    `[hooks] PostToolUse (${call.name}) exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
                  );
                }
              })
              .catch(() => {});
          }
        };

  const runSessionStart = async (): Promise<void> => {
    for (const hook of sessionStart) {
      const r = await runHookCommand(
        hook.command,
        { event: 'SessionStart' },
        cwd,
        timeoutFor(hook)
      );
      if (r.exitCode !== 0) {
        process.stderr.write(
          `[hooks] SessionStart exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
        );
      }
    }
  };

  const runStop = async (info: StopHookInfo): Promise<StopHookResult> => {
    for (const hook of stop) {
      const r = await runHookCommand(
        hook.command,
        {
          event: 'Stop',
          stopReason: info.stopReason,
          ...(info.response ? { response: info.response.slice(-4000) } : {}),
        },
        cwd,
        timeoutFor(hook)
      );
      if (exitBlocks(hook, r)) {
        return { blocked: true, reason: blockReason('Stop', hook, r) };
      }
      if (hookFailed(r)) notice('Stop', hook, r, false);
    }
    return { blocked: false };
  };

  const runSubagentStop = async (info: SubagentStopHookInfo): Promise<void> => {
    for (const hook of subagentStop) {
      const r = await runHookCommand(
        hook.command,
        {
          event: 'SubagentStop',
          goal: info.goal,
          success: info.success,
          ...(info.summary ? { summary: info.summary.slice(0, 4000) } : {}),
        },
        cwd,
        timeoutFor(hook)
      );
      if (r.exitCode !== 0) {
        process.stderr.write(
          `[hooks] SubagentStop exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
        );
      }
    }
  };

  const buildCompactHookRegistry = (): CompactHookRegistry | undefined => {
    if (preCompact.length + postCompact.length === 0) return undefined;
    const registry = new CompactHookRegistry();
    for (const hook of preCompact) {
      registry.registerPre(async (ctx) => {
        const r = await runHookCommand(
          hook.command,
          {
            event: 'PreCompact',
            compactReason: ctx.reason,
            droppedMessages: ctx.messages.length,
          },
          cwd,
          timeoutFor(hook)
        );
        if (r.exitCode !== 0) {
          process.stderr.write(
            `[hooks] PreCompact exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
          );
        }
      });
    }
    for (const hook of postCompact) {
      registry.registerPost(async (ctx) => {
        const r = await runHookCommand(
          hook.command,
          {
            event: 'PostCompact',
            compactReason: ctx.reason,
            summaryChars: ctx.summaryChars,
            droppedMessages: ctx.droppedMessages,
            success: ctx.success,
          },
          cwd,
          timeoutFor(hook)
        );
        if (r.exitCode !== 0) {
          process.stderr.write(
            `[hooks] PostCompact exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
          );
        }
      });
    }
    return registry;
  };

  const runSessionEnd = async (info: { reason: string }): Promise<void> => {
    for (const hook of sessionEnd) {
      const r = await runHookCommand(
        hook.command,
        { event: 'SessionEnd', notificationReason: info.reason },
        cwd,
        timeoutFor(hook)
      );
      if (r.exitCode !== 0) {
        process.stderr.write(
          `[hooks] SessionEnd exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
        );
      }
    }
  };

  const runNotification = async (info: { reason: string; message: string }): Promise<void> => {
    for (const hook of notification) {
      const r = await runHookCommand(
        hook.command,
        {
          event: 'Notification',
          notificationReason: info.reason,
          message: info.message.slice(0, 500),
        },
        cwd,
        timeoutFor(hook)
      );
      if (r.exitCode !== 0) {
        process.stderr.write(
          `[hooks] Notification exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
        );
      }
    }
  };

  const runUserPromptSubmit = async (message: string): Promise<UserPromptSubmitResult> => {
    noticed.clear();
    const extra: string[] = [];
    for (const hook of userPrompt) {
      const r = await runHookCommand(
        hook.command,
        { event: 'UserPromptSubmit', prompt: message },
        cwd,
        timeoutFor(hook)
      );
      const parsed = parseHookJson(r.stdout);
      if (promptBlocks(hook, r, parsed)) {
        return { blocked: true, reason: blockReason('UserPromptSubmit', hook, r, parsed) };
      }
      if (hookFailed(r)) {
        notice('UserPromptSubmit', hook, r, false);
        continue;
      }
      const context = parsed?.additionalContext?.trim() || (parsed ? '' : r.stdout.trim());
      if (context) extra.push(context);
    }
    return extra.length > 0
      ? { blocked: false, extraContext: extra.join('\n') }
      : { blocked: false };
  };

  const runPermissionRequest = async (info: {
    toolName: string;
    input: Record<string, unknown>;
  }): Promise<PermissionRequestResult> => {
    for (const hook of permission) {
      if (!toolNameMatches(hook, info.toolName)) continue;
      const r = await runHookCommand(
        hook.command,
        {
          event: 'PermissionRequest',
          toolName: info.toolName,
          input: info.input,
          ...claudePayload(hook, info.toolName, info.input),
        },
        cwd,
        timeoutFor(hook)
      );
      const parsed = parseHookJson(r.stdout);
      if (promptBlocks(hook, r, parsed)) {
        return { denied: true, reason: blockReason('PermissionRequest', hook, r, parsed) };
      }
      if (hookFailed(r)) notice('PermissionRequest', hook, r, false);
    }
    return { denied: false };
  };

  return {
    onBeforeToolExec,
    onToolResult,
    runSessionStart,
    runStop,
    runSubagentStop,
    runSessionEnd,
    runNotification,
    runUserPromptSubmit,
    runPermissionRequest,
    buildCompactHookRegistry,
    setTuiMode: (on: boolean) => {
      tuiMode = on;
    },
    hasHooks:
      pre.length +
        post.length +
        userPrompt.length +
        permission.length +
        sessionStart.length +
        stop.length +
        subagentStop.length +
        preCompact.length +
        postCompact.length +
        sessionEnd.length +
        notification.length >
      0,
  };
}

// ── Lifecycle hook runner (module singleton, mirrors setCliApprovalAsker) ───
// Core/loop code that finishes a run without access to CLI wiring fires these;
// cli-main installs the real runner at startup. Without a runner everything is
// a no-op, so SDK hosts are unaffected.

export interface StopHookInfo {
  sessionKey: string;
  stopReason?: string;
  response?: string;
}

export interface StopHookResult {
  blocked: boolean;
  reason?: string;
}

export interface UserPromptSubmitResult {
  blocked: boolean;
  reason?: string;
  extraContext?: string;
}

/**
 * Extra context from a successful UserPromptSubmit hook. Redacted, and wrapped
 * so the text cannot be read as a system instruction.
 */
export function formatUserPromptHookContext(userMessage: string, extraContext: string): string {
  const body = redactEgress(extraContext).replaceAll('</hook-output>', '</hook-output\u200b>');
  return `${userMessage}\n\n<hook-output source="UserPromptSubmit">\n${body}\n</hook-output>`;
}

export interface PermissionRequestResult {
  denied: boolean;
  reason?: string;
}

export interface SubagentStopHookInfo {
  sessionKey: string;
  goal: string;
  success: boolean;
  summary?: string;
}

interface LifecycleHookRunner {
  runStop(info: StopHookInfo): Promise<StopHookResult>;
  runSubagentStop(info: SubagentStopHookInfo): Promise<void>;
  runNotification?: (info: { reason: string; message: string }) => Promise<void>;
}

let lifecycleRunner: LifecycleHookRunner | undefined;

export function setLifecycleHookRunner(runner?: LifecycleHookRunner): void {
  lifecycleRunner = runner;
}

export async function runStopHooks(info: StopHookInfo): Promise<StopHookResult> {
  try {
    return (await lifecycleRunner?.runStop(info)) ?? { blocked: false };
  } catch (err) {
    process.stderr.write(`[hooks] Stop hook failed: ${errorMessage(err)}\n`);
    return { blocked: false };
  }
}

export async function runNotificationHooks(info: {
  reason: string;
  message: string;
}): Promise<void> {
  try {
    await lifecycleRunner?.runNotification?.(info);
  } catch (err) {
    process.stderr.write(`[hooks] Notification hook failed: ${errorMessage(err)}\n`);
  }
}

export async function runSubagentStopHooks(info: SubagentStopHookInfo): Promise<void> {
  try {
    await lifecycleRunner?.runSubagentStop(info);
  } catch (err) {
    process.stderr.write(`[hooks] SubagentStop hook failed: ${errorMessage(err)}\n`);
  }
}
