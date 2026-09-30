import type { ToolApprovalRequest, ToolApprovalDecision } from '../core/agent/agent-hooks.js';
import type { ToolCall, ToolResult } from '../core/tools/tool-types.js';
import type { HooksConfig, HookCommandConfig } from './config.js';
import { CompactHookRegistry } from '../core/loop/compact-hooks.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { errorMessage } from '../errors.js';
import { ProcessError, runProcess } from '../utils/run-process.js';

const IS_WIN = process.platform === 'win32';
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface HookPayload {
  event:
    | 'PreToolUse'
    | 'PostToolUse'
    | 'SessionStart'
    | 'Stop'
    | 'SubagentStop'
    | 'PreCompact'
    | 'PostCompact'
    | 'SessionEnd'
    | 'Notification';
  toolName?: string;
  input?: Record<string, unknown>;
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
  const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
  const args = IS_WIN ? ['/c', command] : ['-c', command];
  const env = safeChildEnv({
    LANG: process.env.LANG || 'en_US.UTF-8',
    MOSS_HOOK_EVENT: payload.event,
    MOSS_TOOL_NAME: payload.toolName ?? '',
    MOSS_WORKSPACE: cwd,
  });
  return runProcess(shell, {
    args,
    cwd,
    env,
    timeout: timeoutMs,
    stdin: JSON.stringify(payload),
  })
    .then(({ exitCode, stdout, stderr }) => ({ exitCode, stdout, stderr }))
    .catch((err) => {
      if (err instanceof ProcessError) {
        return {
          exitCode: err.timedOut ? 124 : err.exitCode,
          stdout: err.stdout,
          stderr: err.timedOut
            ? `${err.stderr}\n[hook timed out after ${timeoutMs}ms]`
            : err.stderr,
        };
      }
      return { exitCode: 1, stdout: '', stderr: errorMessage(err) };
    });
}

function toolNameMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function timeoutFor(hook: HookCommandConfig): number {
  return Math.max(1000, Number(hook.timeoutMs) || DEFAULT_HOOK_TIMEOUT_MS);
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
   * PreCompact/PostCompact shell hooks wrapped in the core CompactHookRegistry,
   * ready to hand to MossAgentConfig.compactHooks.
   */
  buildCompactHookRegistry: () => CompactHookRegistry | undefined;

  hasHooks: boolean;
}

export function createConfiguredHookCallbacks(
  hooks: HooksConfig | undefined,
  opts: { workspaceDir: string }
): ConfiguredHookCallbacks {
  const pre = hooks?.PreToolUse ?? [];
  const post = hooks?.PostToolUse ?? [];
  const sessionStart = hooks?.SessionStart ?? [];
  const stop = hooks?.Stop ?? [];
  const subagentStop = hooks?.SubagentStop ?? [];
  const preCompact = hooks?.PreCompact ?? [];
  const postCompact = hooks?.PostCompact ?? [];
  const sessionEnd = hooks?.SessionEnd ?? [];
  const notification = hooks?.Notification ?? [];
  const cwd = opts.workspaceDir;

  const onBeforeToolExec =
    pre.length === 0
      ? undefined
      : async (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
          for (const hook of pre) {
            if (!toolNameMatches(hook.matcher, request.tool.name)) continue;
            const blocking = hook.blocking !== false;
            const r = await runHookCommand(
              hook.command,
              { event: 'PreToolUse', toolName: request.tool.name, input: request.input },
              cwd,
              timeoutFor(hook)
            );
            if (blocking && r.exitCode !== 0) {
              const reason = (r.stderr || r.stdout || `hook exited ${r.exitCode}`)
                .trim()
                .slice(0, 500);
              return { approved: false, reason: `Blocked by PreToolUse hook: ${reason}` };
            }
          }
          return { approved: true };
        };

  const onToolResult =
    post.length === 0
      ? undefined
      : (call: ToolCall, result: ToolResult): void => {
          for (const hook of post) {
            if (!toolNameMatches(hook.matcher, call.name)) continue;
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
      if (hook.blocking !== false && r.exitCode !== 0) {
        const reason = (r.stderr || r.stdout || `hook exited ${r.exitCode}`).trim().slice(0, 500);
        return { blocked: true, reason: `Blocked by Stop hook: ${reason}` };
      }
      if (r.exitCode !== 0) {
        process.stderr.write(
          `[hooks] Stop exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`
        );
      }
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

  return {
    onBeforeToolExec,
    onToolResult,
    runSessionStart,
    runStop,
    runSubagentStop,
    runSessionEnd,
    runNotification,
    buildCompactHookRegistry,
    hasHooks:
      pre.length +
        post.length +
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
