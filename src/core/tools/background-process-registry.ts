/**
 * Background process registry: the agent-loop-facing state that tracks
 * spawned background commands (snapshots, output buffers, lifecycle
 * listeners, waits). Lives in core so the loop's completion reminders can
 * read it without crossing into the tools layer; the exec tool family is
 * the writer.
 */
import { runProcessSync, type ChildProcess } from '../../utils/run-process.js';
import { clearBackgroundCompletionState } from './background-completion-state.js';

export const IS_WIN = process.platform === 'win32';

const MAX_BUFFER = 256 * 1024;

export const MAX_PROCS = 32;

export const DEFAULT_SETTLE_MS = 1200;

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

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

export interface BackgroundProc {
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

export const backgroundProcesses = new Map<string, BackgroundProc>();
let counter = 0;

export function nextBackgroundId(): string {
  return `bg_${++counter}`;
}

const lifecycleListeners = new Set<BackgroundLifecycleListener>();

export function clearBackgroundRegistryForTests(): void {
  for (const proc of backgroundProcesses.values()) {
    if (proc.progressInterval) clearInterval(proc.progressInterval);
    if (proc.killTimer) clearTimeout(proc.killTimer);
    if (proc.status === 'running') killProc(proc);
    proc.outputListeners.clear();
  }
  backgroundProcesses.clear();
  lifecycleListeners.clear();
  counter = 0;
  // Wiping listeners also drops the completion-reminder subscription; reset
  // tracker state so the next ensureBackgroundCompletionTracker() re-binds.
  clearBackgroundCompletionState();
}

export function toSnapshot(proc: BackgroundProc): BackgroundProcSnapshot {
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

export function notifyLifecycle(proc: BackgroundProc): void {
  if (lifecycleListeners.size === 0) return;
  const snapshot = toSnapshot(proc);
  for (const listener of lifecycleListeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

export function appendOutput(
  proc: BackgroundProc,
  stream: 'stdout' | 'stderr',
  chunk: string
): void {
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
    } catch {}
  }
}

export function subscribeBackgroundOutput(
  id: string,
  listener: BackgroundOutputListener
): () => void {
  const proc = backgroundProcesses.get(id);
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
  const proc = backgroundProcesses.get(id);
  return proc ? toSnapshot(proc) : null;
}

export function listBackgroundProcessSnapshots(): BackgroundProcSnapshot[] {
  return [...backgroundProcesses.values()].map(toSnapshot);
}

/**
 * Wait until no background process is still running, or until timeoutMs elapses.
 * Used by oneshot CLI to flush user-visible completion notices before process exit.
 * Returns true if idle (or never had running procs), false on timeout.
 */
export async function waitForBackgroundProcessesIdle(
  timeoutMs = 1500,
  pollMs = 50
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const running = [...backgroundProcesses.values()].some((p) => p.status === 'running');
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
  options: { pollMs?: number; signal?: AbortSignal } = {}
): Promise<BackgroundWaitResult> {
  const pollMs = Math.max(10, options.pollMs ?? 50);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const missing: string[] = [];
  for (const id of ids) {
    if (!backgroundProcesses.has(id)) missing.push(id);
  }
  const isDone = (id: string): boolean => {
    const p = backgroundProcesses.get(id);
    // Unknown ids are not "still running" — don't let a typo hang the wait.
    return p ? p.status !== 'running' : true;
  };
  const check = (): boolean => (mode === 'wait_any' ? ids.some(isDone) : ids.every(isDone));
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
    const p = backgroundProcesses.get(id);
    if (p) out.push(toSnapshot(p));
  }
  return out;
}

/** Trailing output lines for a background process (model-facing reminders). */
export function getBackgroundProcessOutputTail(id: string, lines = 40): string {
  const proc = backgroundProcesses.get(id);
  if (!proc) return '';
  return tailLines(proc.buffer, lines);
}

export function stopBackgroundProcess(id: string): boolean {
  const proc = backgroundProcesses.get(id);
  if (!proc || proc.status !== 'running') return false;
  killProc(proc);
  return true;
}

export function tailLines(text: string, n: number): string {
  const lines = text.split('\n');

  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export function killProc(proc: BackgroundProc): void {
  proc.killRequested = true;
  const pid = proc.child.pid;
  try {
    if (IS_WIN && pid) {
      runProcessSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 2_000,
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
    } catch {}
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
    } catch {}
  }, killEscalationMs);
  if (typeof timer.unref === 'function') timer.unref();
  proc.killTimer = timer;
}

export function describe(proc: BackgroundProc): string {
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
