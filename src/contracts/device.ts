/**
 * Device contract (robotics closed loop P0) — the shared, host-stable types for
 * connecting moss to remote devices (RDK boards, generic Linux hosts).
 *
 * Design rules:
 * - Pure types + constants only; no runtime imports from other layers.
 * - Credentials are referenced, never embedded: targets carry env-var names or
 *   key-file paths, and the connection layer resolves them at connect time so
 *   a serialized DeviceTarget never contains a secret.
 */

/** Device family. `rdk` targets get RDK-specific behavior later; both speak SSH today. */
export type DeviceKind = 'rdk' | 'linux';

/** How to authenticate against the device. Secrets stay in env vars / files. */
export interface DeviceAuthConfig {
  method: 'password' | 'private-key';
  /** Env var holding the password (read at connect time). */
  passwordEnvVar?: string;
  /** Absolute path to a private key file on the moss host. */
  privateKeyPath?: string;
  /** Env var holding the private key passphrase, if any. */
  passphraseEnvVar?: string;
}

/** A connectable device endpoint. Loggable — contains no secret material. */
export interface DeviceTarget {
  deviceId: string;
  kind: DeviceKind;
  host: string;
  port?: number;
  user?: string;
  auth?: DeviceAuthConfig;
  labels?: Record<string, string>;
}

export type DeviceConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Result of one command executed on a device. */
export interface DeviceCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** One entry from a remote directory listing. */
export interface DeviceFileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  sizeBytes?: number;
  mtimeMs?: number;
}

/** Static identity + system facts about a device, from one observation probe. */
export interface DeviceInfoSnapshot {
  deviceId: string;
  kind: DeviceKind;
  connectedAt: number;
  sysname?: string;
  hostname?: string;
  kernel?: string;
  arch?: string;
  osPrettyName?: string;
  cpuModel?: string;
  /** Board hardware line (RDK boards expose this in /proc/cpuinfo). */
  hardware?: string;
  cpuCores?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  uptimeSeconds?: number;
  loadavg?: [number, number, number];
}

export interface DeviceProcessSnapshot {
  pid: number;
  user?: string;
  cpuPercent?: number;
  memPercent?: number;
  rssKb?: number;
  command: string;
}

export interface DeviceProcessListSnapshot {
  deviceId: string;
  collectedAt: number;
  processes: DeviceProcessSnapshot[];
  /** True when the device `ps` did not support the column format we asked for. */
  psUnsupported?: boolean;
}

export interface DeviceDiskUsage {
  filesystem: string;
  mount: string;
  totalBytes?: number;
  availableBytes?: number;
  usedPercent?: number;
}

export interface DeviceResourceSnapshot {
  deviceId: string;
  collectedAt: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  loadavg?: [number, number, number];
  disks: DeviceDiskUsage[];
}

export interface DeviceThermalZone {
  zone: string;
  label?: string;
  celsius: number;
}

export interface DeviceTemperatureSnapshot {
  deviceId: string;
  collectedAt: number;
  zones: DeviceThermalZone[];
}

/** Live state of one managed device connection (for /doctor, registries). */
export interface DeviceConnectionSnapshot {
  target: DeviceTarget;
  status: DeviceConnectionStatus;
  connectedAt?: number;
  lastActiveAt?: number;
  execCount: number;
  lastError?: string;
}

export type DeviceConnectionEvent = 'connected' | 'disconnected' | 'error' | 'reconnecting';

/**
 * The device connection port. Implementations (SSH today) provide command
 * execution and file transfer; observation snapshots build on top of it.
 */
export interface DeviceConnection {
  readonly target: DeviceTarget;
  readonly status: DeviceConnectionStatus;
  exec(command: string, options?: DeviceExecOptions): Promise<DeviceCommandResult>;
  readFile(remotePath: string, options?: DeviceReadFileOptions): Promise<string>;
  writeFile(remotePath: string, options: DeviceWriteFileOptions): Promise<void>;
  listDir(remotePath: string): Promise<DeviceFileEntry[]>;
  disconnect(): Promise<void>;
}

export interface DeviceExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DeviceReadFileOptions {
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface DeviceWriteFileOptions {
  /** Inline content to write. */
  content?: string | Uint8Array;
  /** Local file to upload (faster path for artifacts). */
  localPath?: string;
  /** Unix permission bits, e.g. 0o755. */
  mode?: number;
  signal?: AbortSignal;
}

/**
 * Fleet MVP (v0.25) — one device's slot in a read-only fan-out. `status`
 * distinguishes a real result from a per-device failure so one unreachable
 * device can never erase the others; `endpoint` is the loggable
 * `user@host:port` identity (never a secret).
 */
export interface FleetDeviceResult<T> {
  deviceId: string;
  endpoint: string;
  status: 'pass' | 'fail';
  result?: T;
  error?: string;
}

/** Aggregate of a read-only fleet run: `selector` echoes the resolved ids in
 *  order; `outcome` is the three-state verdict (see {@link FleetOutcome}). */
export interface FleetResult<T> {
  selector: string[];
  outcome: FleetOutcome;
  results: FleetDeviceResult<T>[];
}

export type FleetOutcome = 'all-pass' | 'partial' | 'all-fail';
