/**
 * Batch device operations tool — run commands across multiple connected devices.
 *
 * Provides fleet-wide operations for device groups configured via the
 * FleetManager or MOSS_FLEET_CONFIG environment variable.
 *
 * Actions:
 *  - 'status': show fleet-wide connection status
 *  - 'exec': run a command on selected/all devices in parallel
 *  - 'gather': collect file/info from multiple devices
 *
 * @public
 */
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { FleetManager, parseFleetConfigEnv, type FleetDeviceState } from './fleet-manager.js';
import { runProcess } from '../utils/run-process.js';
import { resolveSshInvocation } from './ssh-utils.js';
import { errorMessage } from '../errors.js';

const BATCH_EXEC_TIMEOUT_MS = 30_000;

export interface BatchDeviceInput {
  /** Action: status, exec, or gather. */
  action: 'status' | 'exec' | 'gather';
  /** Command to run (for 'exec' action). */
  command?: string;
  /** Device aliases to target (empty = all devices). */
  devices?: string[];
  /** File path to read (for 'gather' action). */
  filePath?: string;
  /** Max parallel operations (default 10). */
  maxParallel?: number;
}

interface BatchExecResult {
  alias: string;
  host: string;
  status: 'ok' | 'error' | 'skipped' | 'unreachable';
  output?: string;
  error?: string;
  durationMs: number;
}

async function execOnDevice(
  device: FleetDeviceState,
  command: string,
  timeoutMs: number,
): Promise<{ output: string; durationMs: number }> {
  const startMs = Date.now();
  const sshArgs = buildSshArgs(device.config);
  let sshBin = 'ssh';
  let sshEnv: Record<string, string> | undefined;

  if (device.config.password) {
    const resolved = resolveSshInvocation(device.config, sshArgs);
    sshBin = resolved.bin;
    sshEnv = resolved.env;
  }

  const fullArgs = [...sshArgs, command];
  const result = await runProcess(sshBin, {
    args: fullArgs,
    timeout: timeoutMs,
    ...(sshEnv ? { env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), ...sshEnv } as Record<string, string> } : {}),
  });

  return {
    output: result.stdout?.trim() || '(no output)',
    durationMs: Date.now() - startMs,
  };
}

function buildSshArgs(config: { host: string; user?: string; port?: number; keyPath?: string }): string[] {
  const args: string[] = [];
  if (config.port && config.port !== 22) args.push('-p', String(config.port));
  if (config.keyPath) args.push('-i', config.keyPath);
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'ConnectTimeout=5');
  const target = config.user ? `${config.user}@${config.host}` : config.host;
  args.push(target);
  return args;
}

async function gatherFileFromDevice(
  device: FleetDeviceState,
  filePath: string,
  timeoutMs: number,
): Promise<{ content: string; durationMs: number }> {
  const startMs = Date.now();
  const sshArgs = buildSshArgs(device.config);
  const result = await runProcess('ssh', {
    args: [...sshArgs, `cat "${filePath}"`],
    timeout: timeoutMs,
  });
  return {
    content: result.stdout?.trim() || '(empty)',
    durationMs: Date.now() - startMs,
  };
}

/**
 * Create a batch device operations tool.
 *
 * @public
 */
export function createBatchDeviceTool(
  fleetOrAliases?: FleetManager | FleetDeviceState[],
): Tool<BatchDeviceInput> {
  let fleet: FleetManager;
  let devices: FleetDeviceState[];

  if (fleetOrAliases instanceof FleetManager) {
    fleet = fleetOrAliases;
    devices = fleet.listAll();
  } else if (Array.isArray(fleetOrAliases)) {
    devices = fleetOrAliases;
    fleet = new FleetManager('adhoc', []);
  } else {
    const envConfigs = parseFleetConfigEnv();
    fleet = new FleetManager('env', envConfigs);
    devices = fleet.listAll();
  }

  return {
    name: 'fleet_batch',
    description:
      'Run operations across multiple connected devices. ' +
      'Action "status": show fleet-wide connection status. ' +
      'Action "exec": run a shell command on selected/all devices in parallel. ' +
      'Action "gather": read a file from selected/all devices. ' +
      'Use /fleet to see the current fleet configuration.',
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'exec', 'gather'],
          description: 'Operation: "status" for fleet overview, "exec" to run a command, "gather" to read a file.',
        },
        command: {
          type: 'string',
          description: 'Shell command to run on each device (for "exec" action).',
        },
        devices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Device aliases to target (empty = all devices).',
        },
        filePath: {
          type: 'string',
          description: 'File path to read on each device (for "gather" action).',
        },
        maxParallel: {
          type: 'number',
          description: 'Max parallel operations (default 10).',
        },
      },
      required: ['action'],
    },
    async execute(input, _ctx: ToolContext) {
      const targetDevices = input.devices?.length
        ? devices.filter((d) => input.devices!.includes(d.alias))
        : devices;

      if (targetDevices.length === 0) {
        return 'No devices configured. Set MOSS_FLEET_CONFIG with device aliases, or connect devices with /connect.';
      }

      switch (input.action) {
        case 'status': {
          const status = fleet.getStatus();
          const lines: string[] = [
            `[fleet] ${status.name}: ${status.summary.connected}/${status.summary.total} connected`,
          ];
          for (const device of status.devices) {
            const marker = device.connected ? '🟢' : '⚪';
            const target = `${device.config.user || 'root'}@${device.config.host}:${device.config.port || 22}`;
            lines.push(`  ${marker} ${device.alias.padEnd(16)} ${target}${device.lastSeen ? ` (seen ${Math.round((Date.now() - device.lastSeen) / 1000)}s ago)` : ''}`);
          }
          return lines.join('\n');
        }

        case 'exec': {
          if (!input.command) return 'Error: "command" is required for "exec" action.';

          const maxParallel = Math.max(1, Math.min(input.maxParallel ?? 10, 50));
          const results: BatchExecResult[] = [];
          const startMs = Date.now();

          // Execute in parallel batches
          for (let i = 0; i < targetDevices.length; i += maxParallel) {
            const batch = targetDevices.slice(i, i + maxParallel);
            const batchResults = await Promise.all(
              batch.map(async (device): Promise<BatchExecResult> => {
                if (!device.connected) {
                  return {
                    alias: device.alias,
                    host: device.config.host,
                    status: 'unreachable',
                    error: 'Device not connected',
                    durationMs: 0,
                  };
                }
                try {
                  const { output, durationMs } = await execOnDevice(
                    device,
                    input.command!,
                    BATCH_EXEC_TIMEOUT_MS,
                  );
                  return {
                    alias: device.alias,
                    host: device.config.host,
                    status: 'ok',
                    output: output.slice(0, 2000),
                    durationMs,
                  };
                } catch (err) {
                  return {
                    alias: device.alias,
                    host: device.config.host,
                    status: 'error',
                    error: errorMessage(err).slice(0, 500),
                    durationMs: Date.now() - startMs,
                  };
                }
              }),
            );
            results.push(...batchResults);
          }

          const okCount = results.filter((r) => r.status === 'ok').length;
          const totalDuration = Date.now() - startMs;
          const lines: string[] = [
            `[fleet exec] "${input.command}" — ${okCount}/${results.length} devices OK (${totalDuration}ms)`,
            '',
          ];
          for (const result of results) {
            const marker = result.status === 'ok' ? '✓' : '✗';
            lines.push(`  ${marker} [${result.alias}] ${result.host} (${result.durationMs}ms)`);
            if (result.output) {
              for (const line of result.output.split('\n').slice(0, 5)) {
                lines.push(`    ${line.slice(0, 200)}`);
              }
            }
            if (result.error) {
              lines.push(`    ERROR: ${result.error}`);
            }
            lines.push('');
          }
          return lines.join('\n');
        }

        case 'gather': {
          if (!input.filePath) return 'Error: "filePath" is required for "gather" action.';

          const maxParallel = Math.max(1, Math.min(input.maxParallel ?? 10, 50));
          const results: Array<{ alias: string; host: string; content: string; error?: string }> = [];

          for (let i = 0; i < targetDevices.length; i += maxParallel) {
            const batch = targetDevices.slice(i, i + maxParallel);
            const batchResults = await Promise.all(
              batch.map(async (device) => {
                if (!device.connected) {
                  return { alias: device.alias, host: device.config.host, content: '', error: 'Device not connected' };
                }
                try {
                  const { content } = await gatherFileFromDevice(
                    device,
                    input.filePath!,
                    BATCH_EXEC_TIMEOUT_MS,
                  );
                  return { alias: device.alias, host: device.config.host, content: content.slice(0, 2000) };
                } catch (err) {
                  return {
                    alias: device.alias,
                    host: device.config.host,
                    content: '',
                    error: errorMessage(err).slice(0, 500),
                  };
                }
              }),
            );
            results.push(...batchResults);
          }

          const lines: string[] = [
            `[fleet gather] "${input.filePath}" — ${results.filter((r) => !r.error).length}/${results.length} devices`,
            '',
          ];
          for (const result of results) {
            lines.push(`--- ${result.alias} (${result.host}) ---`);
            if (result.error) {
              lines.push(`  ERROR: ${result.error}`);
            } else {
              lines.push(result.content || '(empty)');
            }
            lines.push('');
          }
          return lines.join('\n');
        }

        default:
          return `Error: unknown action "${(input as BatchDeviceInput).action}". Use "status", "exec", or "gather".`;
      }
    },
  };
}

/**
 * Default batch device tool instance (reads from MOSS_FLEET_CONFIG env).
 *
 * @public
 */
export const batchDeviceTool: Tool<BatchDeviceInput> = createBatchDeviceTool();
