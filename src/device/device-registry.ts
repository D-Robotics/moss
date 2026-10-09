import type {
  DeviceConnection,
  DeviceConnectionSnapshot,
  DeviceTarget,
} from '../contracts/device.js';
import { SshDeviceConnection, type SshConnectOptions } from './ssh-device-connection.js';
import { deviceTargetKey } from './device-target.js';

/**
 * Process-wide device connection registry. Connections are long-lived and
 * shared across tool calls (one multiplexed SSH session per target, like the
 * background-process registry shares writers). Broken connections drop out of
 * the map so the next tool call transparently reconnects.
 */

const connections = new Map<string, SshDeviceConnection>();
const connecting = new Map<string, Promise<DeviceConnection>>();
/** Unreachable results are shared so parallel tools and the next turn do not open more sockets. */
const recentFailures = new Map<string, { at: number; error: unknown }>();
const FAILURE_TTL_MS = 30_000;

/**
 * Task OS §12/M12: transient SSH handshake failures — most notably sshd
 * `MaxStartups` storms when several probes race the same board — previously
 * surfaced as raw errors the agent then spent a dozen turns diagnosing.
 * Connect retries with exponential backoff instead.
 */
const TRANSIENT_CONNECT_PATTERN =
  /maxstartups|connection reset|econnreset|eagain|handshake|pre-authentication/i;
/** A dead route, refused port, or our own connect timer. Retrying these is a reconnect storm. */
const UNREACHABLE_CONNECT_PATTERN =
  /timed out|etimedout|econnrefused|ehostunreach|enetunreach|enotfound|eai_again|network is unreachable|cannot reach|无法在/i;
const CONNECT_BACKOFF_MS = [1500, 4000, 9000];

export function isTransientConnectError(message: string): boolean {
  return TRANSIENT_CONNECT_PATTERN.test(message) && !isUnreachableConnectError(message);
}

export function isUnreachableConnectError(message: string): boolean {
  return UNREACHABLE_CONNECT_PATTERN.test(message);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ConnectBackoffOptions {
  attempts?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, waitMs: number, message: string) => void;
}

/**
 * Connect with exponential backoff on transient handshake errors. The final
 * error carries actionable guidance so agents (and humans) don't
 * re-archaeologize an overloaded sshd.
 */
export async function connectWithBackoff<T>(
  connectOnce: () => Promise<T>,
  options: ConnectBackoffOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const backoff = options.backoffMs ?? CONNECT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectOnce();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (
        attempt >= attempts ||
        isUnreachableConnectError(message) ||
        !isTransientConnectError(message)
      ) {
        throw err;
      }
      const waitMs = backoff[Math.min(attempt - 1, backoff.length - 1)];
      options.onRetry?.(attempt, waitMs, message);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

export function getDeviceConnection(
  target: DeviceTarget,
  options: SshConnectOptions = {}
): Promise<DeviceConnection> {
  const key = deviceTargetKey(target);
  const failed = recentFailures.get(key);
  if (failed && Date.now() - failed.at < FAILURE_TTL_MS) return Promise.reject(failed.error);
  if (failed) recentFailures.delete(key);
  const existing = connections.get(key);
  if (existing && existing.status === 'connected') return Promise.resolve(existing);
  connections.delete(key);
  const pending = connecting.get(key);
  if (pending) return pending;
  const conn = new SshDeviceConnection(target, options);
  const promise = connectWithBackoff(async () => {
    await conn.connect();
    recentFailures.delete(key);
    connections.set(key, conn);
    return conn as DeviceConnection;
  })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (isUnreachableConnectError(message))
        recentFailures.set(key, { at: Date.now(), error: err });
      throw err;
    })
    .finally(() => {
      connecting.delete(key);
    });
  connecting.set(key, promise);
  return promise;
}

export async function disconnectAllDevices(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  recentFailures.clear();
  connecting.clear();
  await Promise.allSettled(all.map((conn) => conn.disconnect()));
}

export function listDeviceConnections(): DeviceConnectionSnapshot[] {
  return [...connections.values()].map((conn) => ({
    target: conn.target,
    status: conn.status,
    ...(conn.lastActiveAt !== undefined ? { lastActiveAt: conn.lastActiveAt } : {}),
    execCount: conn.execCount,
    ...(conn.lastError ? { lastError: conn.lastError } : {}),
  }));
}

// Best-effort cleanup: SSH sockets die with the process anyway; ending them
// politely avoids lingering keepalives around test runners and REPL exits.
for (const signal of ['exit' as const]) {
  process.once(signal, () => {
    for (const conn of connections.values()) void conn.disconnect();
  });
}
