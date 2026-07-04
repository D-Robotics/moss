
















import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { errorMessage } from '../errors.js';

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
  progressInterval?: ReturnType<typeof setInterval>;

  outputListeners: Set<BackgroundOutputListener>;
}











const registry = new Map<string, BackgroundProc>();
let counter = 0;


const lifecycleListeners = new Set<BackgroundLifecycleListener>();


export function clearBackgroundRegistryForTests(): void {
  registry.clear();
  lifecycleListeners.clear();
  counter = 0;
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
      const finish = () => {
        if (done) return;
        done = true;
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
        proc.status = signal ? 'killed' : 'exited';
        proc.exitCode = code;
        proc.signal = signal;
        proc.endedAt = Date.now();
        notifyLifecycle(proc);
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
        finish();
      });
      const timer = setTimeout(finish, settleMs);
      if (typeof timer.unref === 'function') timer.unref();
      ctx.abortSignal?.addEventListener('abort', finish, { once: true });
    });

    await settled;

    const head = tailLines(proc.buffer, 20);
    let outputSection = '';
    if (head) {
      const hasStderr = proc.buffer.includes('\x1b[') || head.toLowerCase().includes('error');
      outputSection = `\n--- ${hasStderr ? 'stderr: ' : ''}output (last 20 lines) ---\n${head}`;
    }
    if (proc.status === 'running') {
      return `Started ${id} (pid ${proc.pid}). Still running after ${settleMs}ms. Use exec_logs("${id}") to monitor and exec_stop("${id}") to terminate.${outputSection}`;
    }
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


export const backgroundExecTools: Tool[] = [execBackgroundTool, execLogsTool, execStopTool];
