import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ErrorCode, MossError } from '../../errors.js';
import { spawnProcess, runProcessSync } from '../../utils/run-process.js';

/** Exact optional upstream supported by integrations/hermit/worker.py. */
export const HERMIT_WORKER_PIN = {
  commit: '2c9d94a1b1437d1c66b80aab05cb0262f557e6d7',
  version: '0.2.0',
  template: 'prompt-only@1.0',
  gepaCommit: 'd771eb21b5dd3228bc3f567293d2ccfc423fc900',
} as const;

export interface HermitWorkerRuntime {
  python: string;
  workerPath: string;
  sourceRoot: string;
}

export interface HermitWorkerCapability {
  available: boolean;
  reasons: string[];
  hermitCommit: string;
  hermitVersion: string;
  gepaCommit: string;
  pythonVersion: string;
  trainerApi: boolean;
  template: 'prompt-only@1.0';
  evolvers: Record<'codex' | 'gepa', { available: boolean; reasons: string[] }>;
  platform: string;
}

export interface HermitWorkerResult {
  method: 'gepa';
  hermitCommit: string;
  hermitVersion: string;
  gepaCommit: string;
  runId: string;
  finalCommit: string;
  steps: Array<{ step: number; commits: string[]; status: string }>;
  instructions: string;
  instructionsSha256: string;
  summarySha256: string;
}

export interface HermitWorkerRun extends HermitWorkerRuntime {
  /** Fresh owned directory. Its input/run.yaml is trusted, never browser-authored code. */
  jobDir: string;
  configSha256: string;
  /** Frozen manifest training allocation; actual HTTP reservations stay authoritative in the host. */
  trainingTokenLimit: number;
  bridgeUrl: string;
  /** Ephemeral job capability, not a provider or device credential. */
  bridgeToken: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Synchronously invalidate the authoritative job lease before stopping children. */
  revoke: () => void;
}

function failure(message: string, code = ErrorCode.EXECUTION_STATE_INVALID, cause?: unknown) {
  return new MossError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

function regularFile(file: string): string {
  const absolute = path.resolve(file);
  if (!fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink())
    throw failure('hermit_worker_file_invalid', ErrorCode.USER_INPUT_INVALID);
  return fs.realpathSync(absolute);
}

function runtimeArgs(runtime: HermitWorkerRuntime, mode: 'probe' | 'train'): string[] {
  const source = fs.realpathSync(runtime.sourceRoot);
  if (!fs.statSync(source).isDirectory())
    throw failure('hermit_source_invalid', ErrorCode.USER_INPUT_INVALID);
  return [regularFile(runtime.workerPath), mode, '--source-root', source];
}

function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  // No inherited HOME, login files, provider keys, Python import path or arbitrary user environment.
  const result: Record<string, string> = { PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...extra };
}

function stopGroup(pid: number | undefined, force: boolean) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      runProcessSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        timeout: 2_000,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function invoke(
  runtime: HermitWorkerRuntime,
  args: string[],
  input: {
    timeoutMs: number;
    signal?: AbortSignal;
    cwd?: string;
    env?: Record<string, string>;
    revoke?: () => void;
  }
): Promise<unknown> {
  if (input.signal?.aborted) {
    input.revoke?.();
    throw failure('hermit_worker_cancelled', ErrorCode.USER_ABORTED);
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000)
    throw failure('hermit_worker_timeout_invalid', ErrorCode.USER_INPUT_INVALID);
  return new Promise((resolve, reject) => {
    let invalidated = false,
      settled = false,
      stdout = '',
      stderrBytes = 0;
    let stopError: MossError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawnProcess(path.resolve(runtime.python), args, {
      cwd: input.cwd,
      env: childEnvironment(input.env),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      input.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };
    const stop = (error: MossError) => {
      if (invalidated || settled) return;
      invalidated = true;
      stopError = error;
      try {
        input.revoke?.();
      } catch (cause) {
        stopError = failure('hermit_job_revoke_failed', ErrorCode.EXECUTION_STATE_INVALID, cause);
      }
      try {
        stopGroup(child.pid, false);
      } catch (cause) {
        stopError = failure('hermit_worker_stop_failed', ErrorCode.EXECUTION_STATE_INVALID, cause);
      }
      killTimer = setTimeout(() => {
        try {
          stopGroup(child.pid, true);
        } catch (cause) {
          stopError = failure(
            'hermit_worker_stop_failed',
            ErrorCode.EXECUTION_STATE_INVALID,
            cause
          );
        }
      }, 250);
      closeTimer = setTimeout(() => finish(stopError), 1_500);
    };
    const abort = () => stop(failure('hermit_worker_cancelled', ErrorCode.USER_ABORTED));
    const deadline = setTimeout(
      () => stop(failure('hermit_worker_timeout', ErrorCode.TOOL_EXECUTION_TIMEOUT)),
      input.timeoutMs
    );
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (invalidated || settled) return;
      if (Buffer.byteLength(stdout) + chunk.length > 1_048_576) {
        stop(failure('hermit_worker_output_limit'));
      } else stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      // Drain but never propagate upstream CLI text that might contain credentials.
      if (stderrBytes > 8_388_608) stop(failure('hermit_worker_log_limit'));
    });
    child.once('error', (cause) =>
      finish(failure('hermit_worker_spawn_failed', ErrorCode.EXECUTION_STATE_INVALID, cause))
    );
    child.once('close', (code, signal) => {
      if (invalidated) {
        // Parent may exit before a TERM-ignoring descendant. Kill only this owned process group.
        try {
          stopGroup(child.pid, true);
        } catch {
          /* stopError retains the failed stop boundary */
        }
        finish(stopError);
      } else if (code !== 0 || signal) finish(failure('hermit_worker_failed'));
      else {
        try {
          finish(undefined, JSON.parse(stdout));
        } catch (cause) {
          finish(
            failure('hermit_worker_protocol_invalid', ErrorCode.EXECUTION_STATE_INVALID, cause)
          );
        }
      }
    });
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('hermit_worker_protocol_invalid');
  return value as Record<string, unknown>;
}

function identity(value: Record<string, unknown>) {
  if (
    value.hermitCommit !== HERMIT_WORKER_PIN.commit ||
    value.hermitVersion !== HERMIT_WORKER_PIN.version ||
    value.gepaCommit !== HERMIT_WORKER_PIN.gepaCommit
  )
    throw failure('hermit_worker_identity_mismatch');
}

/** Runtime-only probe; never installs packages, contacts a model or starts training. */
export async function probeHermitWorker(
  runtime: HermitWorkerRuntime,
  signal?: AbortSignal
): Promise<HermitWorkerCapability> {
  const value = object(
    await invoke(runtime, runtimeArgs(runtime, 'probe'), { timeoutMs: 15_000, signal })
  );
  identity(value);
  if (
    typeof value.available !== 'boolean' ||
    !Array.isArray(value.reasons) ||
    value.reasons.some((r) => typeof r !== 'string') ||
    typeof value.pythonVersion !== 'string' ||
    typeof value.trainerApi !== 'boolean'
  )
    throw failure('hermit_worker_protocol_invalid');
  if (value.template !== HERMIT_WORKER_PIN.template || typeof value.platform !== 'string')
    throw failure('hermit_worker_protocol_invalid');
  const evolvers = object(value.evolvers);
  for (const name of ['codex', 'gepa']) {
    const capability = object(evolvers[name]);
    if (
      typeof capability.available !== 'boolean' ||
      !Array.isArray(capability.reasons) ||
      capability.reasons.some((reason) => typeof reason !== 'string')
    )
      throw failure('hermit_worker_protocol_invalid');
  }
  return value as unknown as HermitWorkerCapability;
}

/** Run only a trusted, digest-bound training config; final holdout evaluation is outside this worker. */
export async function runHermitWorker(input: HermitWorkerRun): Promise<HermitWorkerResult> {
  if (!Number.isSafeInteger(input.trainingTokenLimit) || input.trainingTokenLimit < 1)
    throw failure('hermit_training_budget_invalid', ErrorCode.USER_INPUT_INVALID);
  const jobDir = fs.realpathSync(input.jobDir);
  const config = regularFile(path.join(jobDir, 'input', 'run.yaml'));
  if (
    !config.startsWith(jobDir + path.sep) ||
    !/^[a-f0-9]{64}$/.test(input.configSha256) ||
    createHash('sha256').update(fs.readFileSync(config)).digest('hex') !== input.configSha256
  )
    throw failure('hermit_config_digest_mismatch', ErrorCode.USER_INPUT_INVALID);
  const url = new URL(input.bridgeUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !input.bridgeToken ||
    /[\r\n\0]/.test(input.bridgeToken)
  )
    throw failure('hermit_bridge_invalid', ErrorCode.USER_INPUT_INVALID);
  const args = [
    ...runtimeArgs(input, 'train'),
    '--job-dir',
    jobDir,
    '--config-sha256',
    input.configSha256,
    '--training-token-limit',
    String(input.trainingTokenLimit),
  ];
  const result = object(
    await invoke(input, args, {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      cwd: jobDir,
      env: {
        HOME: path.join(jobDir, 'home'),
        HA_BACKENDS: path.join(jobDir, 'input', 'no-user-backends.yaml'),
        MOSS_HERMIT_JOB_BRIDGE: url.toString().replace(/\/$/, ''),
        MOSS_HERMIT_JOB_TOKEN: input.bridgeToken,
      },
      revoke: input.revoke,
    })
  );
  identity(result);
  if (createHash('sha256').update(fs.readFileSync(config)).digest('hex') !== input.configSha256)
    throw failure('hermit_config_digest_mismatch');
  if (
    result.method !== 'gepa' ||
    typeof result.runId !== 'string' ||
    !result.runId ||
    !/^[a-f0-9]{40}$/.test(String(result.finalCommit)) ||
    typeof result.instructions !== 'string' ||
    !result.instructions.trim() ||
    Buffer.byteLength(result.instructions, 'utf8') > 8192 ||
    createHash('sha256').update(result.instructions).digest('hex') !== result.instructionsSha256 ||
    !/^[a-f0-9]{64}$/.test(String(result.summarySha256)) ||
    !Array.isArray(result.steps) ||
    result.steps.length !== 2
  )
    throw failure('hermit_worker_result_invalid');
  const stepNumbers = new Set<number>();
  for (const raw of result.steps) {
    const step = object(raw);
    if (
      !Number.isSafeInteger(step.step) ||
      ![1, 2].includes(Number(step.step)) ||
      stepNumbers.has(Number(step.step)) ||
      step.status !== 'done' ||
      !Array.isArray(step.commits) ||
      step.commits.some((c) => !/^[a-f0-9]{40}$/.test(String(c)))
    )
      throw failure('hermit_worker_result_invalid');
    stepNumbers.add(Number(step.step));
  }
  return result as unknown as HermitWorkerResult;
}
