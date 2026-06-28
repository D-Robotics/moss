















import type { DeviceSshConfig } from '../tools/device-ssh.js';
import { probeDeviceSsh, type DeviceSshProbeResult } from '../tools/device-ssh.js';
import { errorMessage } from '../errors.js';

export interface FleetDeviceConfig {
  
  alias: string;
  
  ssh: DeviceSshConfig;
}

export interface FleetDeviceState {
  alias: string;
  config: DeviceSshConfig;
  connected: boolean;
  probeResult?: DeviceSshProbeResult;
  lastSeen?: number;
  
  sessionId?: string;
}

export interface FleetStatus {
  
  name: string;
  
  devices: FleetDeviceState[];
  
  summary: {
    total: number;
    connected: number;
    unreachable: number;
  };
}












export function parseFleetConfigEnv(env: NodeJS.ProcessEnv = process.env): FleetDeviceConfig[] {
  const raw = env.MOSS_FLEET_CONFIG;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.alias === 'string' &&
          typeof item.host === 'string'
      )
      .map((item) => ({
        alias: item.alias as string,
        ssh: {
          host: item.host as string,
          user: (item.user as string) || 'root',
          port:
            typeof item.port === 'number'
              ? item.port
              : typeof item.port === 'string'
                ? Number.parseInt(item.port as string, 10) || 22
                : 22,
          ...(item.password ? { password: item.password as string } : {}),
          ...(item.keyPath ? { keyPath: item.keyPath as string } : {}),
          ...(item.rosDomainId
            ? {
                rosDomainId:
                  typeof item.rosDomainId === 'number'
                    ? item.rosDomainId
                    : Number.parseInt(item.rosDomainId as string, 10),
              }
            : {}),
        },
      }));
  } catch {
    return [];
  }
}









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

  
  add(config: FleetDeviceConfig): void {
    this.devices.set(config.alias, {
      alias: config.alias,
      config: config.ssh,
      connected: false,
    });
  }

  
  remove(alias: string): boolean {
    return this.devices.delete(alias);
  }

  
  get(alias: string): FleetDeviceState | undefined {
    return this.devices.get(alias);
  }

  
  listAliases(): string[] {
    return [...this.devices.keys()];
  }

  
  listAll(): FleetDeviceState[] {
    return [...this.devices.values()];
  }

  
  markConnected(alias: string, sessionId?: string): void {
    const device = this.devices.get(alias);
    if (device) {
      device.connected = true;
      device.lastSeen = Date.now();
      device.sessionId = sessionId;
    }
  }

  
  markDisconnected(alias: string): void {
    const device = this.devices.get(alias);
    if (device) {
      device.connected = false;
      device.sessionId = undefined;
    }
  }

  /**
   * Probe all disconnected devices for SSH availability.
   * Returns results for probes that complete before timeout.
   * Incomplete probes are skipped and not included in the result map.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
   *                    Use 'fast' preset (3000ms) for quick checks, or explicit ms value.
   * @returns Map of alias -> DeviceSshProbeResult for completed probes.
   *         Unprobed devices (timeout) will not have an entry.
   */
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

    // Race all probes against timeout. Results added to map are returned.
    // Probes that don't complete in time are silently skipped.
    await Promise.race([
      Promise.all(probes),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return results;
  }

  
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
