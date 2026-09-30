import type {
  DeviceConnection,
  DeviceConnectionSnapshot,
  DeviceTarget,
} from '../contracts/device.js';
import { SshDeviceConnection } from './ssh-device-connection.js';
import { deviceTargetKey } from './device-target.js';

/**
 * Process-wide device connection registry. Connections are long-lived and
 * shared across tool calls (one multiplexed SSH session per target, like the
 * background-process registry shares writers). Broken connections drop out of
 * the map so the next tool call transparently reconnects.
 */

const connections = new Map<string, SshDeviceConnection>();
const connecting = new Map<string, Promise<DeviceConnection>>();

export function getDeviceConnection(target: DeviceTarget): Promise<DeviceConnection> {
  const key = deviceTargetKey(target);
  const existing = connections.get(key);
  if (existing && existing.status === 'connected') return Promise.resolve(existing);
  connections.delete(key);
  const pending = connecting.get(key);
  if (pending) return pending;
  const conn = new SshDeviceConnection(target);
  const promise = conn
    .connect()
    .then(() => {
      connections.set(key, conn);
      return conn as DeviceConnection;
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
