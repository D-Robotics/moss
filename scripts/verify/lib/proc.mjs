/**
 * Process helpers shared by the verify stages.
 *
 * A stage either streams a long command to the terminal (`stdio: 'inherit'`)
 * or captures it so the orchestrator can print a compact failure report
 * (`captureProcess`). A command that hits its timeout is killed and reported
 * as a timeout — never as success.
 */
import { spawn } from 'node:child_process';

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

export function isGithubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

export function annotateError(title, message) {
  if (!isGithubActions()) return;
  console.error(`::error title=${title}::${String(message).replace(/\r?\n/g, '%0A')}`);
}

function spawnChild(command, args, options) {
  try {
    return { child: spawn(command, args, options), error: null };
  } catch (error) {
    return { child: null, error };
  }
}

function timerFor(child, timeoutMs, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) return null;
  const timer = setTimeout(() => {
    onTimeout();
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref?.();
  return timer;
}

/**
 * Run a command with inherited stdio. Resolves once the child closes.
 * @returns {Promise<{status: number|null, signal: string|null, timedOut: boolean, durationMs: number, error?: Error}>}
 */
export function runProcess(command, args, options = {}) {
  const { cwd = process.cwd(), env = process.env, stdio = 'inherit', timeoutMs = 0 } = options;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    const { child, error } = spawnChild(command, args, { cwd, env, stdio, windowsHide: true });
    if (!child) {
      resolve({ status: 1, signal: null, timedOut, durationMs: Date.now() - startedAt, error });
      return;
    }
    const timer = timerFor(child, timeoutMs, () => {
      timedOut = true;
    });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.on('error', (spawnError) => {
      settle({
        status: 1,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        error: spawnError,
      });
    });
    child.on('close', (status, signal) => {
      settle({ status, signal, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

/**
 * Run a command with captured output.
 * @returns {Promise<{status: number|null, signal: string|null, timedOut: boolean, durationMs: number, stdout: string, stderr: string, error?: Error}>}
 */
export function captureProcess(command, args, options = {}) {
  const { cwd = process.cwd(), env = process.env, timeoutMs = 0 } = options;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    const { child, error } = spawnChild(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child) {
      resolve({
        status: 1,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        error,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = timerFor(child, timeoutMs, () => {
      timedOut = true;
    });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.on('error', (spawnError) => {
      settle({
        status: 1,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: spawnError,
      });
    });
    child.on('close', (status, signal) => {
      settle({ status, signal, timedOut, durationMs: Date.now() - startedAt, stdout, stderr });
    });
  });
}
