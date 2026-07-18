
















import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { errorMessage } from '../errors.js';
import {
  clearBackgroundCompletionState,
  markBackgroundIdReported,
} from './background-completion-state.js';

const IS_WIN = process.platform === 'win32';


const MAX_BUFFER = 256 * 1024;

const MAX_PROCS = 32;

const DEFAULT_SETTLE_MS = 1200;





let killEscalationMs = 2000;

export function setKillEscalationMsForTests(ms: number): void {
  killEscalationMs = ms;
}

type BackgroundStatus = 'running' | 'exited' | 'killed' | 'error';







export interface BackgroundProcSnapshot {
  id: string;
  command: string;
  label?: string;
  pid?: number;
  status: BackgroundStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  errorMessage?: string;
  droppedBytes?: number;
}


export interface BackgroundOutputChunk {
  id: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}


export type BackgroundOutputListener = (event: BackgroundOutputChunk) => void;

export type BackgroundLifecycleListener = (snapshot: BackgroundProcSnapshot) => void;

interface BackgroundProc {
  id: string;
  command: string;
  label?: string;
  child: ChildProcess;
  pid?: number;
  status: BackgroundStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  buffer: string;
  errorMessage?: string;
  droppedBytes: number;

  killTimer?: ReturnType<typeof setTimeout>;
  killRequested?: boolean;
  progressInterval?: ReturnType<typeof setInterval>;

  outputListeners: Set<BackgroundOutputListener>;
}











const registry = new Map<string, BackgroundProc>();
let counter = 0;


const lifecycleListeners = new Set<BackgroundLifecycleListener>();


export function clearBackgroundRegistryForTests(): void {
  for (const proc of registry.values()) {
    if (proc.progressInterval) clearInterval(proc.progressInterval);
    if (proc.killTimer) clearTimeout(proc.killTimer);
    if (proc.status === 'running') killProc(proc);
    proc.outputListeners.clear();
  }
  registry.clear();
  lifecycleListeners.clear();
  counter = 0;
  // Wiping listeners also drops the completion-reminder subscription; reset
  // tracker state so the next ensureBackgroundCompletionTracker() re-binds.
  clearBackgroundCompletionState();
}

function toSnapshot(proc: BackgroundProc): BackgroundProcSnapshot {
  return {
    id: proc.id,
    command: proc.command,
    label: proc.label,
    pid: proc.pid,
    status: proc.status,
    exitCode: proc.exitCode,
    signal: proc.signal,
    startedAt: proc.startedAt,
    endedAt: proc.endedAt,
    errorMessage: proc.errorMessage,
    droppedBytes: proc.droppedBytes > 0 ? proc.droppedBytes : undefined,
  };
}

function notifyLifecycle(proc: BackgroundProc): void {
  if (lifecycleListeners.size === 0) return;
  const snapshot = toSnapshot(proc);
  for (const listener of lifecycleListeners) {
    try {
      listener(snapshot);
    } catch {
      
    }
  }
}

function appendOutput(proc: BackgroundProc, stream: 'stdout' | 'stderr', chunk: string): void {
  proc.buffer += chunk;
  if (proc.buffer.length > MAX_BUFFER) {
    const dropped = proc.buffer.length - MAX_BUFFER;
    proc.droppedBytes += dropped;
    proc.buffer = proc.buffer.slice(proc.buffer.length - MAX_BUFFER);
  }
  if (proc.outputListeners.size === 0) return;
  const event: BackgroundOutputChunk = { id: proc.id, stream, chunk };
  for (const listener of proc.outputListeners) {
    try {
      listener(event);
    } catch {

    }
  }
}







export function subscribeBackgroundOutput(
  id: string,
  listener: BackgroundOutputListener
): () => void {
  const proc = registry.get(id);
  if (!proc) return () => {};
  proc.outputListeners.add(listener);
  return () => {
    proc.outputListeners.delete(listener);
  };
}


export function subscribeBackgroundLifecycle(listener: BackgroundLifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}


export function getBackgroundProcessSnapshot(id: string): BackgroundProcSnapshot | null {
  const proc = registry.get(id);
  return proc ? toSnapshot(proc) : null;
}


export function listBackgroundProcessSnapshots(): BackgroundProcSnapshot[] {
  return [...registry.values()].map(toSnapshot);
}


/**
 * Wait until no background process is still running, or until timeoutMs elapses.
 * Used by oneshot CLI to flush user-visible completion notices before process exit.
 * Returns true if idle (or never had running procs), false on timeout.
 */
export async function waitForBackgroundProcessesIdle(
  timeoutMs = 1500,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const running = [...registry.values()].some((p) => p.status === 'running');
    if (!running) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.max(10, pollMs)));
  }
}

export type BackgroundWaitMode = 'wait_any' | 'wait_all';

export interface BackgroundWaitResult {
  /** Whether the mode condition was satisfied before the timeout. */
  completed: boolean;
  /** Whether the wait was cut short by an abort signal. */
  aborted: boolean;
  /** ids the caller asked for that are not in the registry (reported, not waited). */
  missing: string[];
  /** Snapshots of the known ids at wait end. */
  snapshots: BackgroundProcSnapshot[];
}

/**
 * Wait for a specific subset of background processes to finish — `wait_any`
 * resolves when the first completes, `wait_all` waits for every one. Mirrors
 * grok-build's `wait_commands_or_subagents`. Unlike `waitForBackgroundProcessesIdle`
 * (which waits for ALL processes), this scopes to caller-named ids and supports
 * `wait_any` + abort. Unknown ids are reported in `missing` (not treated as
 * pending). Exported for unit testing.
 */
export async function waitForBackgroundProcesses(
  ids: string[],
  mode: BackgroundWaitMode = 'wait_all',
  timeoutMs = 30_000,
  options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<BackgroundWaitResult> {
  const pollMs = Math.max(10, options.pollMs ?? 50);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const missing: string[] = [];
  for (const id of ids) {
    if (!registry.has(id)) missing.push(id);
  }
  const isDone = (id: string): boolean => {
    const p = registry.get(id);
    // Unknown ids are not "still running" — don't let a typo hang the wait.
    return p ? p.status !== 'running' : true;
  };
  const check = (): boolean =>
    mode === 'wait_any' ? ids.some(isDone) : ids.every(isDone);
  while (true) {
    if (check()) {
      return { completed: true, aborted: false, missing, snapshots: snapshotsFor(ids) };
    }
    if (options.signal?.aborted) {
      return { completed: false, aborted: true, missing, snapshots: snapshotsFor(ids) };
    }
    if (Date.now() >= deadline) {
      return { completed: false, aborted: false, missing, snapshots: snapshotsFor(ids) };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function snapshotsFor(ids: string[]): BackgroundProcSnapshot[] {
  const out: BackgroundProcSnapshot[] = [];
  for (const id of ids) {
    const p = registry.get(id);
    if (p) out.push(toSnapshot(p));
  }
  return out;
}


/** Trailing output lines for a background process (model-facing reminders). */
export function getBackgroundProcessOutputTail(id: string, lines = 40): string {
  const proc = registry.get(id);
  if (!proc) return '';
  return tailLines(proc.buffer, lines);
}







export function stopBackgroundProcess(id: string): boolean {
  const proc = registry.get(id);
  if (!proc || proc.status !== 'running') return false;
  killProc(proc);
  return true;
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function killProc(proc: BackgroundProc): void {
  proc.killRequested = true;
  const pid = proc.child.pid;
  try {
    if (IS_WIN && pid) {
      
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.child.kill();
    } else if (pid) {
      process.kill(-pid, 'SIGTERM');
      scheduleSigkillEscalation(proc, pid);
    } else {
      proc.child.kill('SIGTERM');
      scheduleSigkillEscalation(proc, undefined);
    }
  } catch {
    try {
      proc.child.kill('SIGKILL');
    } catch {
      
    }
  }
}






function scheduleSigkillEscalation(proc: BackgroundProc, pid: number | undefined): void {
  if (proc.killTimer) return;
  const timer = setTimeout(() => {
    proc.killTimer = undefined;
    if (proc.status !== 'running') return; 
    try {
      if (pid) process.kill(-pid, 'SIGKILL');
      else proc.child.kill('SIGKILL');
    } catch {
      
    }
  }, killEscalationMs);
  if (typeof timer.unref === 'function') timer.unref();
  proc.killTimer = timer;
}

function describe(proc: BackgroundProc): string {
  const age = Math.round(((proc.endedAt ?? Date.now()) - proc.startedAt) / 1000);
  const tag = proc.label ? ` (${proc.label})` : '';
  const status = proc.status;
  const statusLine = `[${status}]${tag} pid=${proc.pid ?? '?'} age=${age}s`;

  const parts = [`${proc.id}: ${proc.command}`, statusLine];

  if (status === 'error') {
    parts.push(`error: ${proc.errorMessage ?? 'unknown'}`);
  } else if (status !== 'running') {
    parts.push(`exit: ${proc.exitCode ?? '?'}${proc.signal ? ` (signal ${proc.signal})` : ''}`);
  }

  if (proc.droppedBytes > 0) {
    parts.push(`buffer: truncated (${proc.droppedBytes} bytes discarded)`);
  }

  return parts.join('\n  ');
}

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
        description: 'Optional interval in milliseconds to broadcast progress events with recent output (default disabled). Once per interval, emits a progress event via lifecycle listener containing last N lines and elapsed time.',
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

    const danger = isCommandDangerous(command);
    if (danger.blocked) return `Command blocked: ${danger.reason}`;

    const live = [...registry.values()].filter((p) => p.status === 'running').length;
    if (live >= MAX_PROCS) {
      return `Error: too many background processes (${live}/${MAX_PROCS}). Stop one with exec_stop first.`;
    }

    const settleMs = Math.min(Math.max(0, Number(input.settle_ms) || DEFAULT_SETTLE_MS), 10_000);
    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];

    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ctx.workspaceDir,
        env: safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' }),
        detached: !IS_WIN,
        windowsHide: true,
      });
    } catch (err: any) {
      let hint = '';
      if (err.code === 'ENOENT') {
        hint = ' — check that the shell is installed and in PATH';
      } else if (err.code === 'EACCES') {
        hint = ' — permission denied; check file permissions';
      } else if (err.code === 'ENOMEM') {
        hint = ' — insufficient memory to spawn process';
      }
      return `Error starting background command: ${errorMessage(err)}${hint}`;
    }

    const id = `bg_${++counter}`;
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
    registry.set(id, proc);
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
        if (timer) { clearTimeout(timer); timer = undefined; }
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
      // Still running: completion will be injected by background-completion-reminder
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
      if (registry.size === 0) return 'No background processes.';
      return [...registry.values()].map(describe).join('\n');
    }
    const proc = registry.get(id);
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
    const proc = registry.get(id);
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
        description: 'wait_any = resolve when the first id completes; wait_all = wait for all (default).',
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
    const result = await waitForBackgroundProcesses(ids, mode, timeoutMs, { signal: ctx.abortSignal });
    const lines: string[] = [];
    if (result.missing.length) {
      lines.push(`Unknown id(s) — not waited on: ${result.missing.join(', ')}`);
    }
    for (const id of ids) {
      const proc = registry.get(id);
      if (!proc) continue;
      lines.push(describe(proc));
      const tail = tailLines(proc.buffer, 20) || '(no output)';
      lines.push(`  --- last 20 line(s) ---`, tail.split('\n').map((l) => `  ${l}`).join('\n'));
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


export const backgroundExecTools: Tool[] = [execBackgroundTool, execLogsTool, execStopTool, execWaitTool];
