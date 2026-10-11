/**
 * Persisted device registry — `.moss/devices.json`. Entries serialize the
 * same DeviceTarget contract the env resolver produces, so a registered
 * device and an env-configured one behave identically. Auth is stored as
 * references only (env-var names / key paths); a serialized target never
 * contains a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceTarget } from '../contracts/device.js';

export interface DeviceRegistryFile {
  devices: DeviceTarget[];
}

function registryFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', 'devices.json');
}

/**
 * A registry names env vars whose values are sent to the board as an SSH
 * password. A committed `.moss/devices.json` must not name a model or service
 * key (DEEPSEEK_API_KEY, GITHUB_TOKEN, ...), so those names drop the auth.
 */
const NON_DEVICE_SECRET_ENV_NAME =
  /(^|_)(API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|CREDENTIALS?|AUTH)(_|$)/i;

function safeRegistryAuth(auth: unknown): DeviceTarget['auth'] | undefined {
  if (!auth || typeof auth !== 'object') return undefined;
  const record = auth as Record<string, unknown>;
  for (const field of ['passwordEnvVar', 'passphraseEnvVar']) {
    const name = record[field];
    if (name !== undefined && (typeof name !== 'string' || NON_DEVICE_SECRET_ENV_NAME.test(name))) {
      return undefined;
    }
  }
  return auth as DeviceTarget['auth'];
}

export function loadDeviceRegistry(workspaceDir: string): DeviceTarget[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFilePath(workspaceDir), 'utf-8'));
    if (typeof raw !== 'object' || raw === null) return [];
    const devices = (raw as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) return [];
    const out: DeviceTarget[] = [];
    for (const entry of devices) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Partial<DeviceTarget>;
      if (typeof record.deviceId !== 'string' || typeof record.host !== 'string') continue;
      out.push({
        deviceId: record.deviceId,
        kind: record.kind === 'rdk' ? 'rdk' : 'linux',
        host: record.host,
        ...(typeof record.port === 'number' ? { port: record.port } : {}),
        ...(typeof record.user === 'string' ? { user: record.user } : {}),
        ...(safeRegistryAuth(record.auth) ? { auth: safeRegistryAuth(record.auth)! } : {}),
        ...(record.labels && typeof record.labels === 'object' ? { labels: record.labels } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveDeviceRegistry(workspaceDir: string, devices: DeviceTarget[]): void {
  const filePath = registryFilePath(workspaceDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ devices }, null, 2)}\n`, 'utf-8');
}

/** True when the serialized form carries no secret VALUES — env-var
 * references (passwordEnvVar/passphraseEnvVar) and key paths are fine. */
export function registryIsCredentialSafe(devices: DeviceTarget[]): boolean {
  for (const device of devices) {
    const auth = device.auth as Record<string, unknown> | undefined;
    if (!auth) continue;
    for (const [key, value] of Object.entries(auth)) {
      if (key === 'password' || key === 'passphrase' || key === 'passwordValue') return false;
      if (typeof value === 'string' && /^(sk-|ghp_|Bearer )/i.test(value)) return false;
    }
  }
  return true;
}
