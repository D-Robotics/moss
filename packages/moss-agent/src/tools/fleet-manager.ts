/**
 * Fleet manager — manage multiple connected devices in a single moss session.
 *
 * A fleet is a named group of DeviceSshConfig entries that can be connected
 * simultaneously. Devices are identified by a user-defined alias (e.g.,
 * "robot-1", "jetson-nano", "pi-camera").
 *
 * Operations: connect/disconnect individual devices, batch exec across devices,
 * fleet status summary.
 *
 * Configuration via:
 *  - `MOSS_FLEET_CONFIG` env var (JSON): array of {alias, host, user?, port?, ...}
 *  - Config file `fleet` section (future)
 *
 * @public
 */
import type { DeviceSshConfig } from '../tools/device-ssh.js';
import { probeDeviceSsh, type DeviceSshProbeResult } from '../tools/device-ssh.js';
import { errorMessage } from '../errors.js';

export interface FleetDeviceConfig {
  /** User-defined alias (e.g., "rdk-x3", "camera-pi"). Must be unique within the fleet. */
  alias: string;
  /** SSH configuration for this device. */
  ssh: DeviceSshConfig;
}

export interface FleetDeviceState {
  alias: string;
  config: DeviceSshConfig;
  connected: boolean;
  probeResult?: DeviceSshProbeResult;
  lastSeen?: number;
  /** SSH session handle (implementation-specific, managed by the fleet). */
  sessionId?: string;
}

export interface FleetStatus {
  /** Fleet name. */
  name: string;
  /** All configured devices with connection state. */
  devices: FleetDeviceState[];
  /** Summary counts. */
  summary: {
    total: number;
    connected: number;
    unreachable: number;
  };
}

/**
 * Parse fleet config from MOSS_FLEET_CONFIG environment variable.
 *
 * Format: JSON array of {alias, host, user?, port?, password?, keyPath?}
 *
 * @example
 * ```json
 * [{"alias":"rdk-x3","host":"192.168.1.100","user":"root"},
 *  {"alias":"jetson","host":"192.168.1.101","user":"nvidia","port":2222}]
 * ```
 */
export function parseFleetConfigEnv(
  env: NodeJS.ProcessEnv = process.env,
): FleetDeviceConfig[] {
  const raw = env.MOSS_FLEET_CONFIG;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && typeof item.alias === 'string' && typeof item.host === 'string',
      )
      .map((item) => ({
        alias: item.alias as string,
        ssh: {
          host: item.host as string,
          user: (item.user as string) || 'root',
          port: typeof item.port === 'number' ? item.port : (typeof item.port === 'string' ? Number.parseInt(item.port as string, 10) || 22 : 22),
          ...(item.password ? { password: item.password as string } : {}),
          ...(item.keyPath ? { keyPath: item.keyPath as string } : {}),
          ...(item.rosDomainId ? { rosDomainId: typeof item.rosDomainId === 'number' ? item.rosDomainId : Number.parseInt(item.rosDomainId as string, 10) } : {}),
        },
      }));
  } catch {
    return [];
  }
}

/**
 * A simple fleet manager that tracks device connection state.
 *
 * Does NOT manage SSH sessions directly — callers connect via `connectDeviceForSession`
 * and update state via `markConnected`/`markDisconnected`.
 *
 * @public
 */
export class FleetManager {
  readonly name: string;
  private devices = new Map<string, FleetDeviceState>();

  constructor(name: string, configs: FleetDeviceConfig[]) {
    this.name = name;
    for (const cfg of configs) {
      this.devices.set(cfg.alias, {
        alias: cfg.alias,
        config: cfg.ssh,
        connected: false,
      });
    }
  }

  /** Add a device to the fleet. */
  add(config: FleetDeviceConfig): void {
    this.devices.set(config.alias, {
      alias: config.alias,
      config: config.ssh,
      connected: false,
    });
  }

  /** Remove a device from the fleet. */
  remove(alias: string): boolean {
    return this.devices.delete(alias);
  }

  /** Get a device by alias. */
  get(alias: string): FleetDeviceState | undefined {
    return this.devices.get(alias);
  }

  /** List all device aliases. */
  listAliases(): string[] {
    return [...this.devices.keys()];
  }

  /** List all device states. */
  listAll(): FleetDeviceState[] {
    return [...this.devices.values()];
  }

  /** Mark a device as connected. */
  markConnected(alias: string, sessionId?: string): void {
    const device = this.devices.get(alias);
    if (device) {
      device.connected = true;
      device.lastSeen = Date.now();
      device.sessionId = sessionId;
    }
  }

  /** Mark a device as disconnected. */
  markDisconnected(alias: string): void {
    const device = this.devices.get(alias);
    if (device) {
      device.connected = false;
      device.sessionId = undefined;
    }
  }

  /** Probe all disconnected devices for reachability. Returns results per device. */
  async probeAll(timeoutMs = 5000): Promise<Map<string, DeviceSshProbeResult>> {
    const results = new Map<string, DeviceSshProbeResult>();
    const probes = [...this.devices.values()]
      .filter((d) => !d.connected)
      .map(async (device) => {
        try {
          const result = await probeDeviceSsh(device.config);
          results.set(device.alias, result);
          if (result.ok) {
            device.probeResult = result;
          }
          return result;
        } catch (err) {
          results.set(device.alias, { ok: false, kind: 'other', detail: errorMessage(err) });
        }
      });
    // Run all probes in parallel with a combined timeout
    await Promise.race([
      Promise.all(probes),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return results;
  }

  /** Get fleet status summary. */
  getStatus(): FleetStatus {
    const devices = [...this.devices.values()];
    const connected = devices.filter((d) => d.connected).length;
    return {
      name: this.name,
      devices,
      summary: {
        total: devices.length,
        connected,
        unreachable: devices.length - connected,
      },
    };
  }
}
