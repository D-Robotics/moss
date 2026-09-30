import type { DeviceAuthConfig, DeviceKind, DeviceTarget } from '../contracts/device.js';

/**
 * Device target resolution. The moss process reads MOSS_DEVICE_* directly
 * (safeChildEnv strips them from spawned child processes); hosts can also
 * install a target programmatically via configureDefaultDeviceTarget, which
 * wins over the environment.
 */

const ENV_VARS_HELP = [
  'MOSS_DEVICE_HOST   device host (required)',
  'MOSS_DEVICE_PORT   ssh port (default 22)',
  'MOSS_DEVICE_USER   login user (default root)',
  'MOSS_DEVICE_KIND   rdk | linux (default linux)',
  'MOSS_DEVICE_ID     device id label (default derived from kind+host)',
  'MOSS_DEVICE_PASSWORD  password auth (put it in .env, never in the repo)',
  'MOSS_DEVICE_KEY       path to a private key file for key auth',
  'MOSS_DEVICE_KEY_PASSPHRASE  passphrase env var for the key, if needed',
].join('\n');

let hostConfiguredTarget: DeviceTarget | null = null;

/** Host API: install a default device target programmatically (overrides env). */
export function configureDefaultDeviceTarget(target: DeviceTarget | null): void {
  hostConfiguredTarget = target;
}

function envAuth(): DeviceAuthConfig | undefined {
  const privateKeyPath = process.env.MOSS_DEVICE_KEY?.trim();
  if (privateKeyPath) {
    return {
      method: 'private-key',
      privateKeyPath,
      ...(process.env.MOSS_DEVICE_KEY_PASSPHRASE
        ? { passphraseEnvVar: 'MOSS_DEVICE_KEY_PASSPHRASE' }
        : {}),
    };
  }
  if (process.env.MOSS_DEVICE_PASSWORD) {
    return { method: 'password', passwordEnvVar: 'MOSS_DEVICE_PASSWORD' };
  }
  return undefined;
}

function normalizeKind(raw: string | undefined): DeviceKind {
  return raw?.toLowerCase() === 'rdk' ? 'rdk' : 'linux';
}

/** Resolve the default device target: host override first, then MOSS_DEVICE_*. */
export function resolveDefaultDeviceTarget(): DeviceTarget | null {
  if (hostConfiguredTarget) return hostConfiguredTarget;
  const host = process.env.MOSS_DEVICE_HOST?.trim();
  if (!host) return null;
  const kind = normalizeKind(process.env.MOSS_DEVICE_KIND);
  const user = process.env.MOSS_DEVICE_USER?.trim() || 'root';
  const port = Number(process.env.MOSS_DEVICE_PORT) || 22;
  const auth = envAuth();
  return {
    deviceId: process.env.MOSS_DEVICE_ID?.trim() || `${kind}-${host}`,
    kind,
    host,
    port,
    user,
    ...(auth ? { auth } : {}),
  };
}

export function missingTargetHelp(toolName: string): string {
  return (
    `Error: ${toolName}: no device target configured. Set MOSS_DEVICE_HOST (plus auth) in the environment or .env, then retry.\n` +
    `Supported variables:\n${ENV_VARS_HELP}`
  );
}

/** Loggable identity string for a target (no secrets). */
export function formatDeviceTarget(target: DeviceTarget): string {
  return `${target.user || 'root'}@${target.host}:${target.port ?? 22}`;
}

export function deviceTargetKey(target: DeviceTarget): string {
  return `${target.user || 'root'}@${target.host}:${target.port ?? 22}`;
}
