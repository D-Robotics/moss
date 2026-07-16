













import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { ProcessError } from '../utils/run-process.js';
import { wrapAsMoss, ErrorCode, errorMessage } from '../errors.js';
import {
  buildSshCommand,
  missingSshExecutableProcessError,
  runSsh,
  sshBinFor,
  shellEscape,
} from './ssh-utils.js';
import type { DeviceConnectionHealth } from './device-connection-health.js';
import type { DeviceSshExecutor } from './device-ssh-session.js';

export interface DeviceSshConfig {
  host: string;
  user?: string;
  password?: string;
  port?: number;
  keyPath?: string;
  





  rosDomainId?: number;
}

async function sshRun(
  config: DeviceSshConfig,
  remoteCmd: string,
  timeout: number,
  ctx?: Pick<ToolContext, 'abortSignal'>,
  maxBuffer?: number,
  health?: DeviceConnectionHealth,
  operation = 'device SSH command',
  executor?: DeviceSshExecutor
): Promise<string> {
  await health?.beforeOperation(operation);
  let result: Awaited<ReturnType<typeof runSsh>>;
  try {
    result = executor
      ? await executor.run(remoteCmd, {
          timeout,
          maxBuffer: maxBuffer ?? 10 * 1024 * 1024,
          signal: ctx?.abortSignal,
        })
      : await runSsh(config, buildSshCommand(config, remoteCmd), {
          timeout,
          maxBuffer: maxBuffer ?? 10 * 1024 * 1024,
          signal: ctx?.abortSignal,
        });
  } catch (err) {
    await health?.handleFailure(err, { operation, abortSignal: ctx?.abortSignal });
    throw missingSshExecutableProcessError(err, sshBinFor(config)) ?? err;
  }
  return result.stdout.trim() || '(no output)';
}


export type DeviceSshProbeFailureKind =
  | 'auth'
  | 'refused'
  | 'unreachable'
  | 'dns'
  | 'missing-tool'
  | 'other';

export interface DeviceSshProbeResult {
  ok: boolean;
  
  detail: string;
  
  kind?: DeviceSshProbeFailureKind;
}

function classifyProbeFailure(
  config: DeviceSshConfig,
  err: unknown
): { kind: DeviceSshProbeFailureKind; message: string } {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  if (err instanceof ProcessError) {
    const stderr = (err.stderr || '').trim();
    const text = stderr.toLowerCase();
    const tail = stderr.split('\n').slice(-3).join(' ').trim();
    if (
      text.includes('permission denied') ||
      text.includes('authentication fail') ||
      err.exitCode === 5
    ) {
      return {
        kind: 'auth',
        message: `Authentication failed for ${target}.\n` +
          `This could mean:\n` +
          `  • Wrong password or SSH key\n` +
          `  • Wrong username (current: ${config.user || 'root'})\n` +
          `  • SSH running on a different port (current: ${config.port || 22})\n` +
          `Verify with: ssh -vvv ${config.user || 'root'}@${config.host} -p ${config.port || 22}\n` +
          `Then pass: --user <name> --password <pw> / --key <path>, or set MOSS_DEVICE_* env vars.`,
      };
    }
    if (text.includes('connection refused')) {
      return {
        kind: 'refused',
        message: `Connection refused on port ${config.port || 22} of ${config.host}. Check --port and that sshd is running on the board.`,
      };
    }
    if (
      text.includes('timed out') ||
      text.includes('no route to host') ||
      text.includes('host unreachable') ||
      text.includes('network is unreachable')
    ) {
      return {
        kind: 'unreachable',
        message: `Host ${config.host} is unreachable (${tail || 'connection timed out'}). Check the IP and that the board is on the same network.`,
      };
    }
    if (text.includes('could not resolve') || text.includes('not known')) {
      return {
        kind: 'dns',
        message: `Cannot resolve hostname ${config.host}. Check the spelling or use the board IP.`,
      };
    }
    if (err.exitCode === 127) {
      return { kind: 'missing-tool', message: tail || 'SSH executable not found.' };
    }
    return {
      kind: 'other',
      message: `SSH probe failed (exit ${err.exitCode})${tail ? `: ${tail}` : ''}. Target: ${target}.`,
    };
  }
  return {
    kind: 'other',
    message: `SSH probe failed for ${target}: ${errorMessage(err)}`,
  };
}







export async function probeDeviceSsh(
  config: DeviceSshConfig,
  options: {
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    executor?: DeviceSshExecutor;
  } = {}
): Promise<DeviceSshProbeResult> {
  try {
    const hostname = await sshRun(
      config,
      'uname -n 2>/dev/null || hostname',
      options.timeoutMs ?? 15_000,
      { abortSignal: options.abortSignal },
      64 * 1024,
      undefined,
      'SSH probe',
      options.executor
    );
    return {
      ok: true,
      detail: hostname === '(no output)' ? config.host : hostname.split('\n')[0].trim(),
    };
  } catch (err) {
    const classified = classifyProbeFailure(config, err);
    return { ok: false, detail: classified.message, kind: classified.kind };
  }
}

export function createDeviceSshTools(
  config: DeviceSshConfig,
  health?: DeviceConnectionHealth,
  executor?: DeviceSshExecutor
): Tool[] {
  const deviceExec: Tool = {
    name: 'device_exec',
    description: `Execute a shell command on the connected device (${config.host}) via SSH. ` +
      `(This tool is replaced by 'exec' when /connect is active to the device workspace.)`,
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on the device' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
      required: ['command'],
    },
    async execute(input, ctx) {
      const timeout = Number(input.timeout_ms) || 30_000;
      const safetyCheck = isCommandDangerous(input.command);
      if (safetyCheck.blocked) {
        return `Command blocked: ${safetyCheck.reason}`;
      }
      try {
        return await sshRun(
          config,
          input.command,
          timeout,
          ctx,
          undefined,
          health,
          'device_exec',
          executor
        );
      } catch (err) {
        if (err instanceof ProcessError && err.timedOut) {
          const timeoutSec = Math.round(timeout / 1000);
          const suggestion = timeout < 60000 ? timeout * 4 : timeout * 2;
          const suggestionSec = Math.round(suggestion / 1000);
          throw new Error(
            `Device command timed out after ${timeoutSec}s. The command may still be running.\n` +
            `For build/install operations (colcon build, apt install, etc.), typical durations:\n` +
            `  • colcon build on X5: 180-300s\n` +
            `  • apt install: 60-180s\n` +
            `  • other operations: depends on device load\n` +
            `Try increasing timeout_ms to ${suggestion} (${suggestionSec}s) or run commands in stages. ` +
            `For long-running tasks, consider using nohup + background monitoring.`
          );
        }
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          throw new Error(
            `Device command failed (exit ${err.exitCode}):\n${output || err.message}`
          );
        }
        throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and credentials',
          recoverable: true,
        });
      }
    },
  };

  const deviceInfo: Tool = {
    name: 'device_info',
    description: 'Get basic information about the connected device (hostname, OS, CPU, memory).',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const commands = [
        'echo "hostname: $(hostname)"',
        'echo "os: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"\\")"',
        'echo "kernel: $(uname -r)"',
        'echo "arch: $(uname -m)"',
        'echo "cpu: $(nproc) cores"',
        "echo \"memory: $(free -h | awk '/^Mem:/{print $2}') total, $(free -h | awk '/^Mem:/{print $3}') used\"",
        "echo \"disk: $(df -h / | awk 'NR==2{print $2}') total, $(df -h / | awk 'NR==2{print $3}') used\"",
        'echo "uptime: $(uptime -p 2>/dev/null || uptime)"',
      ];
      try {
        return await sshRun(
          config,
          commands.join(' && '),
          15_000,
          ctx,
          1024 * 1024,
          health,
          'device_info',
          executor
        );
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          throw new Error(
            `Failed to get device info (exit ${err.exitCode}):\n${output || err.message}`
          );
        }
        throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and device power',
          recoverable: true,
        });
      }
    },
  };

  const deviceFileRead: Tool = {
    name: 'device_file_read',
    description: 'Read a file from the connected device. ' +
      '(This tool is replaced by "read_file" when /connect is active to the device workspace.)',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on the device' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      try {
        const content = await sshRun(
          config,
          `cat ${shellEscape(input.path)}`,
          15_000,
          ctx,
          5 * 1024 * 1024,
          health,
          'device_file_read',
          executor
        );
        if (content.length > 100_000) {
          return (
            content.slice(0, 100_000) +
            '\n\n[... truncated at 100KB. This tool has limited read capacity. ' +
            'For larger files, use device_exec with "head", "tail", or "sed" to extract sections.]'
          );
        }
        return content || '(empty file)';
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          throw new Error(
            `Failed to read ${input.path} (exit ${err.exitCode}):\n${output || err.message}`
          );
        }
        throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and file path',
          recoverable: true,
        });
      }
    },
  };

  const deviceFileList: Tool = {
    name: 'device_file_list',
    description: 'List files in a directory on the connected device. ' +
      '(This tool is replaced by "list_directory" when /connect is active to the device workspace.)',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path on the device (default: /home)' },
      },
    },
    async execute(input, ctx) {
      const dir = input.path || '/home';
      try {
        return await sshRun(
          config,
          `ls -la ${shellEscape(dir)}`,
          10_000,
          ctx,
          undefined,
          health,
          'device_file_list',
          executor
        );
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          throw new Error(
            `Failed to list ${dir} (exit ${err.exitCode}):\n${output || err.message}`
          );
        }
        throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and directory path',
          recoverable: true,
        });
      }
    },
  };

  return [deviceExec, deviceInfo, deviceFileRead, deviceFileList];
}

export function getDeviceConfigFromEnv(): DeviceSshConfig | null {
  const host = process.env.MOSS_DEVICE_HOST;
  if (!host) return null;

  const rawDomain = process.env.MOSS_ROS_DOMAIN_ID;
  const parsedDomain = rawDomain !== undefined ? Number.parseInt(rawDomain, 10) : NaN;

  const portStr = process.env.MOSS_DEVICE_PORT || '22';
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MOSS_DEVICE_PORT: "${portStr}" (must be 1-65535)`);
  }

  return {
    host,
    user: process.env.MOSS_DEVICE_USER || 'root',
    password: process.env.MOSS_DEVICE_PASSWORD,
    port,
    keyPath: process.env.MOSS_DEVICE_KEY,
    ...(Number.isInteger(parsedDomain) && parsedDomain >= 0 ? { rosDomainId: parsedDomain } : {}),
  };
}
