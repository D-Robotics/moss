







import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { wrapAsMoss, ErrorCode } from '../errors.js';
import { buildSshCommand, runSsh, sshBinFor, shellEscape, sshFailureToError } from './ssh-utils.js';

const ROS_SETUP =
  'source /opt/tros/humble/setup.bash 2>/dev/null || source /opt/ros/humble/setup.bash 2>/dev/null || true';






export function clampSampleSeconds(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, 60);
}


export const ROS2_LAUNCH_OK_MARKER = '__MOSS_ROS2_LAUNCH_OK__';

export const ROS2_LAUNCH_DEAD_MARKER = '__MOSS_ROS2_LAUNCH_DEAD__';







export function interpretRos2LaunchOutput(output: string, pkg: string, launchFile: string): string {
  const okLine = output.split('\n').find((line) => line.includes(ROS2_LAUNCH_OK_MARKER));
  if (okLine) {
    const pid = okLine.match(/pid=(\d+)/)?.[1];
    return `Launched ${pkg}/${launchFile} (detached${pid ? `, pid ${pid}` : ''}, still alive after 3s). Log: /tmp/ros2_launch_${pkg}.log`;
  }
  if (output.includes(ROS2_LAUNCH_DEAD_MARKER)) {
    const logLines = output
      .split('\n')
      .filter((line) => !line.includes(ROS2_LAUNCH_DEAD_MARKER));

    // Extract error keywords from the last 20 lines
    const errorIndicators = logLines
      .slice(-20)
      .filter((line) => /error|Error|ERROR|failed|FAILED|fail|Cannot|cannot/i.test(line));

    const logTail = logLines.join('\n').trim();
    let errorMsg = `ros2 launch ${pkg}/${launchFile} exited within 3s — process did NOT stay alive.\n`;

    if (errorIndicators.length > 0) {
      errorMsg += `Key error indicators:\n${errorIndicators.slice(-3).map((line) => `  ${line.trim()}`).join('\n')}\n`;
    }

    if (logTail) {
      errorMsg += `\nFull log tail:\n${logTail}`;
    } else {
      errorMsg += '\nLog output was empty.';
    }

    errorMsg += `\nDiagnostic steps:\n` +
      `  1. Check the full log: cat /tmp/ros2_launch_${pkg}.log\n` +
      `  2. Verify dependencies: ros2 pkg list | grep ${pkg}\n` +
      `  3. Check ROS_DOMAIN_ID: echo $ROS_DOMAIN_ID\n` +
      `  4. Try running the launch file directly: ros2 launch ${pkg} ${launchFile}`;

    throw new Error(errorMsg);
  }
  throw new Error(
    `ros2_launch could not verify the process state (unexpected output):\n${output || '(no output)'}`
  );
}






export function ros2DomainPrefix(config: DeviceSshConfig): string {
  return typeof config.rosDomainId === 'number' && Number.isInteger(config.rosDomainId)
    ? `export ROS_DOMAIN_ID=${config.rosDomainId}; `
    : '';
}

async function sshExec(
  config: DeviceSshConfig,
  cmd: string,
  timeout = 15_000,
  ctx?: ToolContext
): Promise<string> {
  const remoteCmd = `${ros2DomainPrefix(config)}${ROS_SETUP} && ${cmd}`;
  const sshArgs = buildSshCommand(config, remoteCmd, 5);

  try {
    const result = await runSsh(config, sshArgs, {
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      signal: ctx?.abortSignal,
    });
    return result.stdout.trim();
  } catch (err) {
    
    
    
    const sshError = sshFailureToError(err, sshBinFor(config));
    if (sshError) throw sshError;
    throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity and ROS2 installation',
      recoverable: true,
    });
  }
}

export function createRos2Tools(config: DeviceSshConfig): Tool[] {
  const ros2TopicList: Tool = {
    name: 'ros2_topic_list',
    description: 'List all active ROS2 topics on the device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 topic list -t', 15_000, ctx);
    },
  };

  const ros2TopicEcho: Tool = {
    name: 'ros2_topic_echo',
    description: 'Subscribe to a ROS2 topic and show one message. Wait longer for low-rate topics.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name (e.g. /camera/image_raw)' },
        timeout_sec: {
          type: 'number',
          description:
            'Seconds to wait for a message (default 5, max 60). Raise it for low-rate topics (e.g., 30+ seconds for topics publishing < 0.2 Hz).',
        },
      },
      required: ['topic'],
    },
    async execute(input, ctx) {
      const window = clampSampleSeconds(input.timeout_sec);
      return sshExec(
        config,
        `timeout ${window} ros2 topic echo ${shellEscape(input.topic)} --once 2>&1 || echo "(no message within ${window}s)"`,
        (window + 5) * 1000,
        ctx
      );
    },
  };

  const ros2TopicHz: Tool = {
    name: 'ros2_topic_hz',
    description: 'Measure the publishing rate of a ROS2 topic. Requires at least 2+ messages within the timeout.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name' },
        timeout_sec: {
          type: 'number',
          description:
            'Seconds to sample the rate (default 5, max 60). Increase for low-frequency topics (e.g., 30s for topics publishing < 0.1 Hz).',
        },
      },
      required: ['topic'],
    },
    async execute(input, ctx) {
      const window = clampSampleSeconds(input.timeout_sec);
      const result = await sshExec(
        config,
        `timeout ${window} ros2 topic hz ${shellEscape(input.topic)} 2>&1 | tail -5`,
        (window + 5) * 1000,
        ctx
      );

      // Check if no messages were received
      if (result.includes('no data') || (result.length < 50 && !result.includes('Hz'))) {
        return result + `\n\nNo data received within ${window}s. Check:\n` +
          `  1. Is the topic active? Run: ros2 topic list\n` +
          `  2. What is the publishing rate? Run: ros2 topic echo ${input.topic} (watch for message arrival)\n` +
          `  3. Is ROS_DOMAIN_ID correct? Current: ${config.rosDomainId ?? '(not set)'}`;
      }
      return result;
    },
  };

  const ros2NodeList: Tool = {
    name: 'ros2_node_list',
    description: 'List all active ROS2 nodes on the device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 node list', 15_000, ctx);
    },
  };

  const ros2ServiceList: Tool = {
    name: 'ros2_service_list',
    description: 'List all active ROS2 services on the device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(config, 'ros2 service list -t', 15_000, ctx);
    },
  };

  const ros2ServiceCall: Tool = {
    name: 'ros2_service_call',
    description: 'Call a ROS2 service with specified arguments.',
    
    
    
    metadata: { sideEffectClass: 'device_mutation', planMode: 'requires_user_confirmation' },
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name' },
        type: { type: 'string', description: 'Service type (e.g. std_srvs/srv/Trigger)' },
        args: { type: 'string', description: 'YAML arguments (e.g. "{}") ' },
      },
      required: ['service', 'type'],
    },
    async execute(input, ctx) {
      const args = input.args || '{}';
      return sshExec(
        config,
        `ros2 service call ${shellEscape(input.service)} ${shellEscape(input.type)} ${shellEscape(args)}`,
        15_000,
        ctx
      );
    },
  };

  const ros2Launch: Tool = {
    name: 'ros2_launch',
    description:
      'Launch a ROS2 launch file on the device (runs detached; verifies the process is still alive after 3s).',
    
    
    metadata: { sideEffectClass: 'device_mutation', planMode: 'requires_user_confirmation' },
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'ROS2 package name' },
        launch_file: { type: 'string', description: 'Launch file name' },
        args: { type: 'string', description: 'Additional launch arguments' },
      },
      required: ['package', 'launch_file'],
    },
    async execute(input, ctx) {
      const args = input.args ? ` ${shellEscape(input.args)}` : '';
      const logFile = `/tmp/ros2_launch_${shellEscape(input.package)}.log`;



      const cmd =
        `nohup ros2 launch ${shellEscape(input.package)} ${shellEscape(input.launch_file)}${args} > ${logFile} 2>&1 & ` +
        `pid=$!; sleep 3; ` +
        `if kill -0 "$pid" 2>/dev/null; then echo "${ROS2_LAUNCH_OK_MARKER} pid=$pid"; ` +
        `else echo "${ROS2_LAUNCH_DEAD_MARKER}"; tail -n 20 ${logFile} 2>/dev/null; fi`;
      const output = await sshExec(config, cmd, 10_000, ctx);
      return interpretRos2LaunchOutput(output, input.package, input.launch_file);
    },
  };

  const ros2PkgList: Tool = {
    name: 'ros2_pkg_list',
    description: 'List installed ROS2 packages on the device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by name (grep pattern)' },
      },
    },
    async execute(input, ctx) {
      const cmd = input.filter
        ? `ros2 pkg list | grep -i ${shellEscape(input.filter)}`
        : 'ros2 pkg list | head -50';
      return sshExec(config, cmd, 15_000, ctx);
    },
  };

  return [
    ros2TopicList,
    ros2TopicEcho,
    ros2TopicHz,
    ros2NodeList,
    ros2ServiceList,
    ros2ServiceCall,
    ros2Launch,
    ros2PkgList,
  ];
}
