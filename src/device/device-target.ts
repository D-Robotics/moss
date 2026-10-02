import type { DeviceAuthConfig, DeviceKind, DeviceTarget } from '../contracts/device.js';
import { loadDeviceRegistry } from './device-registry-file.js';

/**
 * Device target resolution, three sources in precedence order:
 *  1. a host-installed programmatic target (configureDefaultDeviceTarget),
 *  2. MOSS_DEVICE_* environment variables (credentials in .env only),
 *  3. the workspace device registry `.moss/devices.json` (persisted by
 *     `moss device add`; auth stored as env-var references, never values).
 *
 * The moss process reads MOSS_DEVICE_* directly (safeChildEnv strips them
 * from spawned child processes).
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
/** Workspace whose .moss/devices.json backs the registry fallback. */
let hostConfiguredWorkspace: string | null = null;

/** Host API: install a default device target programmatically (overrides env). */
export function configureDefaultDeviceTarget(target: DeviceTarget | null): void {
  hostConfiguredTarget = target;
}

/**
 * Host API: declare the workspace whose `.moss/devices.json` backs the
 * registry fallback in resolveDefaultDeviceTarget. Without it the registry
 * tier is inert (env/host sources still work).
 */
export function configureDeviceWorkspace(workspaceDir: string | null): void {
  hostConfiguredWorkspace = workspaceDir;
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

/**
 * Resolve the default device target: host override, then MOSS_DEVICE_* env,
 * then the workspace registry's first (or named) entry. Returns null when no
 * source is configured.
 */
export function resolveDefaultDeviceTarget(
  options: { workspaceDir?: string; registryDeviceId?: string } = {}
): DeviceTarget | null {
  if (hostConfiguredTarget) return hostConfiguredTarget;
  const host = process.env.MOSS_DEVICE_HOST?.trim();
  if (host) {
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
  const workspaceDir = options.workspaceDir ?? hostConfiguredWorkspace ?? undefined;
  if (workspaceDir) {
    const registry = loadDeviceRegistry(workspaceDir);
    if (registry.length > 0) {
      return (
        registry.find((device) => device.deviceId === options.registryDeviceId) ?? registry[0]!
      );
    }
  }
  return null;
}

export { loadDeviceRegistry };

/** Outcome of resolving an explicit fleet selector against the workspace registry. */
export interface DeviceTargetSelection {
  /** Resolved targets in the user's (deduped) order. */
  targets: DeviceTarget[];
  /** Selector ids not present in the registry, in the user's order. */
  missing: string[];
  /** True when the selector carried no usable id (whitespace/empty). */
  empty: boolean;
}

/**
 * Resolve an explicit set of registry device ids (Fleet MVP v0.25). This is the
 * multi-target sibling of the single-target `resolveDefaultDeviceTarget`: it
 * NEVER falls back to a default or fans out the whole registry implicitly, so
 * "which devices ran" is always exactly what the user named.
 *
 * Selector ids are trimmed, deduped preserving order, and matched against the
 * workspace registry only. Unknown ids are collected (not thrown) so the caller
 * can report every missing id at once before connecting anything.
 */
export function resolveDeviceTargets(
  selector: readonly string[],
  options: { workspaceDir?: string } = {}
): DeviceTargetSelection {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of selector) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  if (ordered.length === 0) return { targets: [], missing: [], empty: true };
  const workspaceDir = options.workspaceDir ?? hostConfiguredWorkspace ?? undefined;
  const registry = workspaceDir ? loadDeviceRegistry(workspaceDir) : [];
  const byId = new Map(registry.map((device) => [device.deviceId, device]));
  const targets: DeviceTarget[] = [];
  const missing: string[] = [];
  for (const id of ordered) {
    const target = byId.get(id);
    if (target) targets.push(target);
    else missing.push(id);
  }
  return { targets, missing, empty: false };
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
