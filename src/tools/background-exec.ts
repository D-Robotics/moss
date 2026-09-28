import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { spawnProcess, type ChildProcess } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertShellWritesWithinRoots } from '../safety/shell-write-sandbox.js';
import { errorMessage } from '../errors.js';
import { markBackgroundIdReported } from '../core/tools/background-completion-state.js';
import {
  appendOutput,
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

export const execBackgroundTool: Tool = {
  name: 'exec_background',
  description:
    'Start a shell command in the background (a server, watcher, or other long-running process) and return a handle id. ' +
    'Unlike exec, it does not block: use exec_logs to read its output and exec_stop to terminate it. ' +
    'Briefly watches the process after start so an immediate crash is reported inline.',
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
        description: `Time to watch for an immediate crash before returning (default ${DEFAULT_SETTLE_MS}, max 10000)`,
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

    const live = [...backgroundProcesses.values()].filter((p) => p.status === 'running').length;
    if (live >= MAX_PROCS) {
      return `Error: too many background processes (${live}/${MAX_PROCS}). Stop one with exec_stop first.`;
    }

    const settleMs = Math.min(Math.max(0, Number(input.settle_ms) || DEFAULT_SETTLE_MS), 10_000);
    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];

    let child: ChildProcess;
    try {
      child = spawnProcess(shell, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ctx.workspaceDir,
        env: safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' }),
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

    child.stdout?.on('data', (c: Buffer) => appendOutput(proc, 'stdout', c.toString()));
    child.stderr?.on('data', (c: Buffer) => appendOutput(proc, 'stderr', c.toString()));

    if (progressIntervalMs > 0) {
      const timer = setInterval(() => {
        if (proc.status !== 'running') return;
        notifyLifecycle(proc);
      }, progressIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      proc.progressInterval = timer;
    }

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
        proc.status = proc.killRequested || signal ? 'killed' : 'exited';
        proc.exitCode = code;
        proc.signal = signal;
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
    if (proc.status === 'running') {
      // Still running: completion will be injected by core/loop/background-completion
      // when the process later exits (Grok TaskCompletionReminder parity).
      return `Started ${id} (pid ${proc.pid}). Still running after ${settleMs}ms. You will be notified when it finishes; use exec_logs("${id}") to monitor and exec_stop("${id}") to terminate.${outputSection}`;
    }
    // Terminal during settle — already fully reported in this tool result; suppress
    // a later system-reminder duplicate (lifecycle already enqueued the snapshot).
    markBackgroundIdReported(id);
    if (proc.status === 'error') {
      return `Background command ${id} failed to start: ${proc.errorMessage}${outputSection}`;
    }
    return `Background command ${id} exited immediately (exit ${proc.exitCode}${proc.signal ? `, signal ${proc.signal}` : ''}).${outputSection}`;
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
    'Wait for one or more background commands (started by exec_background) to finish — ' +
    'mode=wait_any returns when the first completes; wait_all (default) waits for every one. ' +
    'Returns each id status + output tail. Use this to coordinate parallel dev servers / test ' +
    'suites / builds in one call instead of polling exec_logs one id at a time. Caps at 20 ids ' +
    'and 120s timeout.',
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
