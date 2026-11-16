import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { abortable } from '../agent/abort.js';
import { ErrorCode, MossError, errorMessage, isMossError } from '../../errors.js';

/** Host opt-in for observing an existing task; never enables mutation retries. */
export interface TaskObservationPolicy {
  maxWaitMs?: number;
  initialPollMs?: number;
  maxPollMs?: number;
}

export interface ToolWaitProgress {
  state: 'waiting' | 'resumed' | 'timed_out';
  elapsedMs: number;
  pollCount: number;
  nextPollInMs?: number;
  /** Fraction from 0 to 1, only supplied when the tool explicitly reports it. */
  progress?: number;
}

export interface TaskObservation {
  taskId: string;
  status: string;
  record: Record<string, unknown>;
  progress?: number;
}

export interface ToolWaitTimeout {
  taskId: string;
  status: string;
  elapsedMs: number;
}

const ACTIVE = new Set(['running', 'queued', 'pending', 'in_progress']);
const TERMINAL = new Set([
  'completed',
  'complete',
  'succeeded',
  'success',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'stopped',
  'done',
]);
const MAX_WAIT_MS = 30 * 60_000;
const MAX_LOG_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function mergeObservationResult(text: string, observed: Record<string, unknown>): string {
  const envelope = json(text);
  if (record(envelope) && record(envelope.structuredContent)) {
    return JSON.stringify({ ...envelope, structuredContent: observed });
  }
  if (
    record(envelope) &&
    Array.isArray(envelope.content) &&
    envelope.content.length === 1 &&
    record(envelope.content[0]) &&
    envelope.content[0].type === 'text'
  ) {
    return JSON.stringify({
      ...envelope,
      content: [{ ...envelope.content[0], text: JSON.stringify(observed) }],
    });
  }
  return JSON.stringify(observed);
}

/** Strict data-only compatibility for JSON tools and MCP structured/text envelopes. */
export function readTaskObservation(
  value: unknown,
  input: Record<string, unknown>
): TaskObservation | null {
  let body = json(value);
  if (!record(body) || body.isError === true) return null;
  if (record(body.structuredContent)) body = body.structuredContent;
  else if (Array.isArray(body.content)) {
    if (body.content.length !== 1 || !record(body.content[0]) || body.content[0].type !== 'text')
      return null;
    body = json(body.content[0].text);
  }
  if (!record(body) || body.isError === true || typeof body.status !== 'string') return null;
  const status = body.status.toLowerCase();
  if (!ACTIVE.has(status) && !TERMINAL.has(status)) return null;
  const idKey = ['taskId', 'jobId', 'runId'].find(
    (key) => typeof input[key] === 'string' && input[key] !== '' && input[key] === body[key]
  );
  if (!idKey || typeof body[idKey] !== 'string') return null;
  const percent = body.progressPercent;
  const fraction = body.progress;
  const progress =
    typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      ? fraction
      : typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? percent / 100
        : undefined;
  return {
    taskId: body[idKey],
    status,
    record: body,
    ...(progress !== undefined ? { progress } : {}),
  };
}

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(ceiling, Math.max(1, Math.floor(value)))
    : fallback;
}

export function taskObservationWaitMs(policy: TaskObservationPolicy): number {
  return bounded(policy.maxWaitMs, MAX_WAIT_MS, MAX_WAIT_MS);
}

interface ObservationResult {
  text: string;
  isError?: boolean;
}

/** Waits inside one tool invocation, without generating additional model turns. */
export async function waitForTaskObservation(options: {
  input: Record<string, unknown>;
  initial: ObservationResult;
  policy: TaskObservationPolicy;
  execute: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<ObservationResult>;
  signal?: AbortSignal;
  onProgress?: (progress: ToolWaitProgress) => void;
}): Promise<ObservationResult & { waitTimeout?: ToolWaitTimeout }> {
  let latest = options.initial;
  let observation = !latest.isError ? readTaskObservation(latest.text, options.input) : null;
  if (!observation || !ACTIVE.has(observation.status)) return latest;
  const taskId = observation.taskId;
  const invocationNonce = randomUUID();
  const startedAt = Date.now();
  const maxWaitMs = taskObservationWaitMs(options.policy);
  const initialPollMs = bounded(options.policy.initialPollMs, 2_000, 30_000);
  const maxPollMs = Math.max(initialPollMs, bounded(options.policy.maxPollMs, 30_000, 30_000));
  let pollMs = initialPollMs;
  let pollCount = 0;
  let fingerprint = JSON.stringify(observation.record);
  const logs = new Map<string, unknown>();
  let logBytes = 0;
  let omittedLines = 0;
  const collectLogs = (current: TaskObservation) => {
    if (!Array.isArray(current.record.lines)) return;
    for (const line of current.record.lines) {
      const serialized = JSON.stringify(line);
      const key =
        record(line) && typeof line.n === 'number'
          ? `${String(line.stream ?? '')}:${line.n}`
          : serialized;
      if (logs.has(key)) continue;
      const bytes = Buffer.byteLength(serialized);
      if (logBytes + bytes > MAX_LOG_BYTES) {
        omittedLines++;
        continue;
      }
      logs.set(key, line);
      logBytes += bytes;
    }
  };
  const result = (current: TaskObservation, timedOut = false) => {
    const elapsedMs = Date.now() - startedAt;
    return {
      text: mergeObservationResult(latest.text, {
        ...current.record,
        ...(logs.size > 0 || Array.isArray(current.record.lines)
          ? { lines: [...logs.values()] }
          : {}),
        ...(omittedLines ? { truncated: true, observationOmittedLines: omittedLines } : {}),
        ...(timedOut
          ? {
              observationWait: {
                state: 'timed_out',
                elapsedMs,
                pollCount,
                remoteTaskCancelled: false,
              },
            }
          : {}),
      }),
      ...(timedOut ? { waitTimeout: { taskId, status: current.status, elapsedMs } } : {}),
    };
  };
  const historyText = () =>
    logs.size > 0
      ? `\n\n[Earlier observations; not the current task state]\n${JSON.stringify({ taskId, lines: [...logs.values()], ...(omittedLines ? { omittedLines } : {}) })}`
      : '';
  collectLogs(observation);
  while (ACTIVE.has(observation.status)) {
    options.signal?.throwIfAborted();
    const remainingMs = maxWaitMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      options.onProgress?.({
        state: 'timed_out',
        elapsedMs: Date.now() - startedAt,
        pollCount,
        ...(observation.progress !== undefined ? { progress: observation.progress } : {}),
      });
      return result(observation, true);
    }
    const nextPollInMs = Math.min(remainingMs, pollMs);
    options.onProgress?.({
      state: 'waiting',
      elapsedMs: Date.now() - startedAt,
      pollCount,
      nextPollInMs,
      ...(observation.progress !== undefined ? { progress: observation.progress } : {}),
    });
    await delay(nextPollInMs, undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
    if (Date.now() - startedAt >= maxWaitMs) continue;
    pollCount++;
    const input = { ...options.input };
    if (typeof input.idempotencyKey === 'string') {
      const digest = createHash('sha256')
        .update(`${input.idempotencyKey}:${invocationNonce}`)
        .digest('hex')
        .slice(0, 24);
      input.idempotencyKey = `observe-${digest}-${pollCount}`;
    }
    const deadline = AbortSignal.timeout(Math.max(1, maxWaitMs - (Date.now() - startedAt)));
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      latest = await abortable(options.execute(input, signal), signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!deadline.aborted) {
        const previous = historyText();
        if (!previous) throw error;
        throw new MossError({
          code: isMossError(error) ? error.code : ErrorCode.TOOL_EXECUTION_FAILED,
          message: errorMessage(error) + previous,
          cause: error,
          ...(isMossError(error) ? { recoverable: error.recoverable, hint: error.hint } : {}),
        });
      }
      continue;
    }
    const next = !latest.isError ? readTaskObservation(latest.text, options.input) : null;
    if (!next || next.taskId !== taskId) {
      options.onProgress?.({ state: 'resumed', elapsedMs: Date.now() - startedAt, pollCount });
      return { ...latest, text: latest.text + historyText() };
    }
    observation = next;
    collectLogs(observation);
    const nextFingerprint = JSON.stringify(observation.record);
    pollMs = nextFingerprint === fingerprint ? Math.min(maxPollMs, pollMs * 2) : initialPollMs;
    fingerprint = nextFingerprint;
  }
  options.onProgress?.({
    state: 'resumed',
    elapsedMs: Date.now() - startedAt,
    pollCount,
    ...(observation.progress !== undefined ? { progress: observation.progress } : {}),
  });
  return result(observation);
}
