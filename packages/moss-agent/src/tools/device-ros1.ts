import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { ErrorCode, wrapAsMoss } from '../errors.js';
import type { DeviceConnectionHealth } from './device-connection-health.js';
import type { DeviceSshConfig } from './device-ssh.js';
import type { DeviceSshExecutor } from './device-ssh-session.js';
import { buildSshCommand, runSsh, shellEscape, sshBinFor, sshFailureToError } from './ssh-utils.js';
import { buildRosEnvironmentCommand as buildEnvironment } from './device-ros-environment.js';

export function buildRosEnvironmentCommand(command: string): string {
  return buildEnvironment({ commandName: 'rostopic', command });
}

async function ros1Exec(
  config: DeviceSshConfig,
  command: string,
  timeout: number,
  ctx: ToolContext | undefined,
  health: DeviceConnectionHealth | undefined,
  operation: string,
  executor: DeviceSshExecutor | undefined
): Promise<string> {
  await health?.beforeOperation(operation);
  const remoteCommand = buildRosEnvironmentCommand(command);
  try {
    const result = executor
      ? await executor.run(remoteCommand, {
          timeout,
          maxBuffer: 5 * 1024 * 1024,
          signal: ctx?.abortSignal,
        })
      : await runSsh(config, buildSshCommand(config, remoteCommand, 5), {
          timeout,
          maxBuffer: 5 * 1024 * 1024,
          signal: ctx?.abortSignal,
        });
    return result.stdout.trim() || '(no output)';
  } catch (error) {
    await health?.handleFailure(error, { operation, abortSignal: ctx?.abortSignal });
    const sshError = sshFailureToError(error, sshBinFor(config));
    if (sshError) throw sshError;
    throw wrapAsMoss(error, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity, ROS_MASTER_URI, roscore, and ROS1 installation',
      recoverable: true,
    });
  }
}

export function createRos1Tools(
  config: DeviceSshConfig,
  health?: DeviceConnectionHealth,
  executor?: DeviceSshExecutor
): Tool[] {
  const readonly = { sideEffectClass: 'readonly', planMode: 'allow' } as const;
  return [
    {
      name: 'ros1_topic_list',
      description: 'List active ROS1 topics and types on the connected robot.',
      metadata: readonly,
      inputSchema: { type: 'object', properties: {} },
      execute: (_input, ctx) =>
        ros1Exec(config, 'rostopic list -v', 15_000, ctx, health, 'ros1_topic_list', executor),
    },
    {
      name: 'ros1_topic_echo',
      description: 'Read one message from a ROS1 topic.',
      metadata: readonly,
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'ROS1 topic name' },
          timeout_sec: { type: 'number', description: 'Wait time in seconds (default 5, max 60)' },
        },
        required: ['topic'],
      },
      execute(input, ctx) {
        const seconds = Math.max(1, Math.min(60, Math.floor(Number(input.timeout_sec) || 5)));
        return ros1Exec(
          config,
          `timeout ${seconds} rostopic echo -n 1 ${shellEscape(input.topic)}`,
          (seconds + 5) * 1000,
          ctx,
          health,
          'ros1_topic_echo',
          executor
        );
      },
    },
    {
      name: 'ros1_node_list',
      description: 'List active ROS1 nodes on the connected robot.',
      metadata: readonly,
      inputSchema: { type: 'object', properties: {} },
      execute: (_input, ctx) =>
        ros1Exec(config, 'rosnode list', 15_000, ctx, health, 'ros1_node_list', executor),
    },
    {
      name: 'ros1_service_list',
      description: 'List active ROS1 services and types on the connected robot.',
      metadata: readonly,
      inputSchema: { type: 'object', properties: {} },
      execute: (_input, ctx) =>
        ros1Exec(config, 'rosservice list', 15_000, ctx, health, 'ros1_service_list', executor),
    },
  ];
}
