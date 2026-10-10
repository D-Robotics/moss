import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { spawnProcess, type ChildProcess } from '../utils/run-process.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertShellWritesWithinRoots } from '../safety/shell-write-sandbox.js';
import { errorMessage } from '../errors.js';
import { deviceEnvFootnote } from '../utils/safe-child-env.js';
import { commandMentionsMossCredential } from '../safety/read-scope.js';
import { redactEgress } from '../safety/tool-output-redact.js';
import {
  extractShellMutationPaths,
  shellCommandHasWriteAction,
} from '../context/stale-read-invalidate.js';
import {
  filesWithIncreasedPlaceholderCount,
  formatRedactedWritebackWarning,
  redactedShellWriteRefusal,
  snapshotMutationFiles,
} from '../safety/redacted-writeback.js';
import { markBackgroundIdReported } from '../core/tools/background-completion-state.js';
import {
  appendOutput,
  replaceBackgroundOutput,
  backgroundProcesses,
  IS_WIN,
  DEFAULT_SETTLE_MS,
  describe,
  errnoCode,
  killProc,
  MAX_PROCS,
  nextBackgroundId,
  notifyLifecycle,
  waitForBackgroundProcesses,
  tailLines,
  type BackgroundProc,
  type BackgroundWaitMode,
} from '../core/tools/background-process-registry.js';
import { EXEC_DEFAULT_TIMEOUT_MS, openChildEnv, takeShellNotices } from './tool-helpers.js';

/**
 * Wait out a background command only for the runTask/resumeTask that set
 * `goalExecWait` on this call. A live task file in the workspace is not
 * enough: a later chat, or a dev server started with wait:false / settle_ms,
 * keeps the short settle.
 */
function goalWaitMsFor(
  input: { timeout_ms?: unknown; settle_ms?: unknown; wait?: unknown },
  ctx: ToolContext
): number | null {
  if (ctx.goalExecWait !== true) return null;
  if (input.wait === false) return null;
  if (input.settle_ms !== undefined) return null;
  const requested = Number(input.timeout_ms);
  return Number.isFinite(requested) && requested > 0 ? requested : EXEC_DEFAULT_TIMEOUT_MS;
}

/** Raw chunks, so a secret split across writes is redacted once it is complete. */
const rawBackgroundOutput = new Map<string, string>();
const RAW_OUTPUT_CAP = 256 * 1024;

function publishRedactedOutput(proc: BackgroundProc, text: string): void {
  let raw = (rawBackgroundOutput.get(proc.id) ?? '') + text;
  if (raw.length > RAW_OUTPUT_CAP) raw = raw.slice(raw.length - RAW_OUTPUT_CAP);
  rawBackgroundOutput.set(proc.id, raw);
  replaceBackgroundOutput(proc, redactEgress(raw));
}

export const execBackgroundTool: Tool = {
  name: 'exec_background',
  description:
    'Start a long-running command and return a handle. Outside /goal it returns after settle_ms. During a goal it waits until exit or timeout_ms unless settle_ms is set or wait is false. Read output with exec_logs; stop with exec_stop. An immediate crash is reported inline.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Spawns a detached host process. Host must enforce approval via AgentHooks.onBeforeToolExec.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run in the background' },
      label: { type: 'string', description: 'Optional human-readable label for the process' },
      settle_ms: {
        type: 'number',
        description: `Time to watch for an immediate crash before returning (default ${DEFAULT_SETTLE_MS}, max 10000). Setting this during a /goal run keeps that short settle instead of waiting for the command to exit.`,
      },
      wait: {
        type: 'boolean',
        description:
          'Set false to return after settle_ms even during a /goal run (dev servers and watchers). Default during /goal is to wait until the command exits or timeout_ms.',
      },
      timeout_ms: {
        type: 'number',
        description:
          'During a /goal run, wait up to this many milliseconds for the command to exit (default 120000) unless settle_ms is set or wait is false. Outside a goal this is ignored.',
      },
      progress_interval_ms: {
        type: 'number',
        description:
          'Optional interval in milliseconds to broadcast progress events with recent output (default disabled). Once per interval, emits a progress event via lifecycle listener containing last N lines and elapsed time.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx: ToolContext) {
    if (ctx.abortSignal?.aborted) {
      return 'Background command cancelled before start.';
    }

    const command = String(input.command ?? '').trim();
    if (!command) return 'Error: command is required';

    if (ctx.execWriteRoots && ctx.execWriteRoots.length > 0) {
      try {
        await assertShellWritesWithinRoots(command, {
          cwd: ctx.workspaceDir,
          roots: ctx.execWriteRoots,
        });
      } catch (err) {
        return (
          `Error: shell write escapes the workspace sandbox (${err instanceof Error ? err.message : String(err)}). ` +
          'Write to a path inside the workspace instead.'
        );
      }
    }
    const danger = isCommandDangerous(command);
    if (danger.blocked) return `Command blocked: ${danger.reason}`;
    const redactedWrite = redactedShellWriteRefusal(command, shellCommandHasWriteAction(command));
    if (redactedWrite) return redactedWrite;
    const mutationSnap = snapshotMutationFiles(
      ctx.workspaceDir || process.cwd(),
      extractShellMutationPaths(command)
    );

    const live = [...backgroundProcesses.values()].filter((p) => p.status === 'running').length;
    if (live >= MAX_PROCS) {
      return `Error: too many background processes (${live}/${MAX_PROCS}). Stop one with exec_stop first.`;
    }

    const goalWaitMs = goalWaitMsFor(input, ctx);
    const settleMs =
      goalWaitMs ?? Math.min(Math.max(0, Number(input.settle_ms) || DEFAULT_SETTLE_MS), 10_000);
    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];

    const opened = await openChildEnv(ctx.workspaceDir, ctx.abortSignal);
    const hooksNotice = (output = ''): string =>
      takeShellNotices(ctx.sessionKey, opened, command, output);
    let child: ChildProcess;
    try {
      child = spawnProcess(shell, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ctx.workspaceDir,
        env: opened.env,
        detached: !IS_WIN,
        windowsHide: true,
      });
    } catch (err) {
      let hint = '';
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        hint = ' — check that the shell is installed and in PATH';
      } else if (code === 'EACCES') {
        hint = ' — permission denied; check file permissions';
      } else if (code === 'ENOMEM') {
        hint = ' — insufficient memory to spawn process';
      }
      return `Error starting background command: ${errorMessage(err)}${hint}`;
    }

    const id = nextBackgroundId();
    const progressIntervalMs = Math.max(0, Number(input.progress_interval_ms) || 0);
    const proc: BackgroundProc = {
      id,
      command,
      label: typeof input.label === 'string' ? input.label : undefined,
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      child,
      pid: child.pid,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      buffer: '',
      droppedBytes: 0,
      outputListeners: new Set(),
    };
    backgroundProcesses.set(id, proc);
    notifyLifecycle(proc);

    const hideCredential = commandMentionsMossCredential(command);
    let withheldCredential = false;
    const onStream = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (hideCredential && /\.apikey-key\b/.test(command)) {
        if (withheldCredential) return;
        withheldCredential = true;
        appendOutput(proc, stream, 'Moss credential values withheld.\n');
        return;
      }
      publishRedactedOutput(proc, chunk.toString());
    };
    child.stdout?.on('data', (c: Buffer) => onStream('stdout', c));
    child.stderr?.on('data', (c: Buffer) => onStream('stderr', c));

    if (progressIntervalMs > 0) {
      const timer = setInterval(() => {
        if (proc.status !== 'running') return;
        notifyLifecycle(proc);
      }, progressIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      proc.progressInterval = timer;
    }

    let writebackChecked = false;
    const finishWriteback = () => {
      if (writebackChecked) return;
      writebackChecked = true;
      const writebackWarning = formatRedactedWritebackWarning(
        filesWithIncreasedPlaceholderCount(mutationSnap)
      );
      if (writebackWarning) appendOutput(proc, 'stderr', writebackWarning);
      rawBackgroundOutput.delete(proc.id);
    };

    const settled = new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (proc.status !== 'running') return;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        killProc(proc);
      };
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (proc.progressInterval) {
          clearInterval(proc.progressInterval);
          proc.progressInterval = undefined;
        }
        resolve();
      };
      // Use 'close' (not 'exit'): 'exit' fires when the process exits but the
      // stdout/stderr pipes may still have buffered data the parent hasn't
      // drained — settling on 'exit' lost tail output for fast-exiting
      // processes. 'close' fires only after all stdio streams are drained, so
      // proc.buffer is complete when notifyLifecycle/finish runs. Matches
      // run-process.ts:127.
      child.on('close', (code, signal) => {
        if (proc.killTimer) {
          clearTimeout(proc.killTimer);
          proc.killTimer = undefined;
        }
        finishWriteback();
        proc.status = proc.killRequested || signal ? 'killed' : 'exited';
        proc.exitCode = code;
        // A handler that exits 0 after SIGTERM leaves `signal` null. Record the
        // signal we sent so the UI does not call that a clean exit 0.
        proc.signal = signal ?? (proc.killRequested ? 'SIGTERM' : null);
        proc.endedAt = Date.now();
        notifyLifecycle(proc);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
        finish();
      });
      child.on('error', (err) => {
        if (proc.killTimer) {
          clearTimeout(proc.killTimer);
          proc.killTimer = undefined;
        }
        finishWriteback();
        proc.status = 'error';
        proc.errorMessage = err.message;
        proc.endedAt = Date.now();
        notifyLifecycle(proc);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
        finish();
      });
      timer = setTimeout(finish, settleMs);
      if (typeof timer.unref === 'function') timer.unref();
      ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (ctx.abortSignal?.aborted) onAbort();
    });

    await settled;

    const head = tailLines(proc.buffer, 20);
    let outputSection = '';
    if (head) {
      const hasStderr = proc.buffer.includes('\x1b[') || head.toLowerCase().includes('error');
      outputSection = `\n--- ${hasStderr ? 'stderr: ' : ''}output (last 20 lines) ---\n${head}`;
    }
    const footnote = deviceEnvFootnote(command);
    if (proc.status === 'running') {
      // Still running: completion will be injected by core/loop/background-completion
      // when the process later exits (Grok TaskCompletionReminder parity).
      if (goalWaitMs !== null) {
        return (
          `Started ${id} (pid ${proc.pid}). Still running after ${settleMs}ms — backgrounded at the wait timeout. ` +
          `Wait with exec_wait({"ids":["${id}"]}) before treating the goal as finished; ` +
          `use exec_logs("${id}") to monitor and exec_stop("${id}") to terminate.${outputSection}${footnote}${hooksNotice(proc.buffer)}`
        );
      }
      return `Started ${id} (pid ${proc.pid}). Still running after ${settleMs}ms. You will be notified when it finishes; use exec_logs("${id}") to monitor and exec_stop("${id}") to terminate.${outputSection}${footnote}${hooksNotice(proc.buffer)}`;
    }
    // Terminal during settle — already fully reported in this tool result; suppress
    // a later system-reminder duplicate (lifecycle already enqueued the snapshot).
    markBackgroundIdReported(id);
    if (proc.status === 'error') {
      return `Background command ${id} failed to start: ${proc.errorMessage}${outputSection}${footnote}${hooksNotice(proc.buffer)}`;
    }
    return `Background command ${id} exited immediately (exit ${proc.exitCode}${proc.signal ? `, signal ${proc.signal}` : ''}).${outputSection}${footnote}${hooksNotice(proc.buffer)}`;
  },
};

export const execLogsTool: Tool = {
  name: 'exec_logs',
  description:
    'Read the status and recent output of a background command started by exec_background. ' +
    'Omit `id` to list all tracked background processes.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background process id (e.g. "bg_1"). Omit to list all.' },
      tail: {
        type: 'number',
        description: 'Number of trailing output lines to return (default 100, max 1000)',
      },
    },
  },
  async execute(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      if (backgroundProcesses.size === 0) return 'No background processes.';
      return [...backgroundProcesses.values()].map(describe).join('\n');
    }
    const proc = backgroundProcesses.get(id);
    if (!proc)
      return `Error: no background process with id "${id}". Use exec_logs (no id) to list them.`;
    const tail = Math.min(Math.max(1, Number(input.tail) || 100), 1000);
    const body = tailLines(proc.buffer, tail) || '(no output captured)';
    return `${describe(proc)}\n--- last ${tail} line(s) ---\n${body}`;
  },
};

export const execStopTool: Tool = {
  name: 'exec_stop',
  description:
    'Stop a background command started by exec_background (terminates its process group on POSIX).',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background process id to stop (e.g. "bg_1")' },
    },
    required: ['id'],
  },
  async execute(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return 'Error: id is required';
    const proc = backgroundProcesses.get(id);
    if (!proc) return `Error: no background process with id "${id}".`;
    if (proc.status !== 'running') {
      const age = Math.round((proc.endedAt ? proc.endedAt - proc.startedAt : 0) / 1000);
      const tail = tailLines(proc.buffer, 10) || '(no output)';
      return `${id} is already ${proc.status} (ran for ${age}s, exit ${proc.exitCode ?? '?'})\n--- last output ---\n${tail}`;
    }
    killProc(proc);
    const age = Math.round((Date.now() - proc.startedAt) / 1000);
    const tail = tailLines(proc.buffer, 10) || '(no output)';
    return `Stopping ${id} (pid ${proc.pid}, age ${age}s)\n--- last output ---\n${tail}`;
  },
};

export const execWaitTool: Tool = {
  name: 'exec_wait',
  description:
    'Wait for background commands. mode=wait_all (default) waits for every id; wait_any returns when the first finishes. Caps at 20 ids and 120s.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Background process ids to wait on, e.g. ["bg_1","bg_2"] (1-20).',
      },
      mode: {
        type: 'string',
        enum: ['wait_any', 'wait_all'],
        description:
          'wait_any = resolve when the first id completes; wait_all = wait for all (default).',
      },
      timeout_ms: {
        type: 'number',
        description: 'Max wait in ms (default 30000, max 120000).',
      },
    },
    required: ['ids'],
  },
  async execute(input, ctx) {
    const rawIds = Array.isArray(input?.ids) ? input.ids : [];
    const ids = rawIds
      .map((v: unknown) => String(v).trim())
      .filter(Boolean)
      .slice(0, 20);
    if (ids.length === 0) {
      return 'No ids provided. Start commands with exec_background, then exec_wait with their ids (e.g. ["bg_1","bg_2"]).';
    }
    const mode: BackgroundWaitMode = input?.mode === 'wait_any' ? 'wait_any' : 'wait_all';
    const timeoutMs = Math.min(120_000, Math.max(1000, Number(input?.timeout_ms) || 30_000));
    const result = await waitForBackgroundProcesses(ids, mode, timeoutMs, {
      signal: ctx.abortSignal,
    });
    const lines: string[] = [];
    if (result.missing.length) {
      lines.push(`Unknown id(s) — not waited on: ${result.missing.join(', ')}`);
    }
    for (const id of ids) {
      const proc = backgroundProcesses.get(id);
      if (!proc) continue;
      lines.push(describe(proc));
      const tail = tailLines(proc.buffer, 20) || '(no output)';
      lines.push(
        `  --- last 20 line(s) ---`,
        tail
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')
      );
    }
    const verdict = result.aborted
      ? 'aborted'
      : result.completed
        ? mode === 'wait_any'
          ? 'wait_any satisfied (first completed)'
          : 'wait_all satisfied (all completed)'
        : 'timed out';
    lines.push(`\n${verdict} after ${timeoutMs}ms (mode=${mode}, ${ids.length} id(s)).`);
    return lines.join('\n');
  },
};

export const backgroundExecTools: Tool[] = [
  execBackgroundTool,
  execLogsTool,
  execStopTool,
  execWaitTool,
];
