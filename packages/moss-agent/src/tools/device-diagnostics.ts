







import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { wrapAsMoss, ErrorCode } from '../errors.js';
import { buildSshCommand, runSsh, sshBinFor, sshFailureToError } from './ssh-utils.js';

async function sshExec(
  config: DeviceSshConfig,
  cmd: string,
  timeout = 10_000,
  ctx?: ToolContext
): Promise<string> {
  const sshArgs = buildSshCommand(config, cmd, 5);

  try {
    const result = await runSsh(config, sshArgs, {
      timeout,
      maxBuffer: 1024 * 1024,
      signal: ctx?.abortSignal,
    });
    return result.stdout.trim();
  } catch (err) {
    
    
    
    const sshError = sshFailureToError(err, sshBinFor(config));
    if (sshError) throw sshError;
    throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity and device power',
      recoverable: true,
    });
  }
}

export function createDeviceDiagnosticsTools(config: DeviceSshConfig): Tool[] {
  const deviceTemperature: Tool = {
    name: 'device_temperature',
    description: 'Read CPU and NPU/BPU temperature from the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== CPU Temperature ==="',
        'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | while read t; do echo "  $(echo "scale=1; $t/1000" | bc 2>/dev/null || echo $((t/1000)))°C"; done || echo "N/A"',
        'echo ""',
        'echo "=== Accelerator Temperature ==="',
        'cat /sys/class/hwmon/hwmon*/temp*_input 2>/dev/null | while read t; do echo "  $(echo "scale=1; $t/1000" | bc 2>/dev/null || echo $((t/1000)))°C"; done || echo "N/A"',
        'echo ""',
        'echo "=== GPU Temperature ==="',
        'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -5 | while read t; do echo "  $(echo "scale=1; $t/1000" | bc 2>/dev/null || echo $((t/1000)))°C"; done || echo "N/A"',
      ].join(' && ');
      return sshExec(config, cmd, 10_000, ctx);
    },
  };

  const deviceResources: Tool = {
    name: 'device_resources',
    description: 'Get CPU, memory, and disk usage of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== CPU Usage ==="',
        'top -bn1 | head -5',
        'echo ""',
        'echo "=== Memory ==="',
        'free -h',
        'echo ""',
        'echo "=== Disk ==="',
        'df -h / /tmp /userdata 2>/dev/null | grep -v tmpfs',
        'echo ""',
        'echo "=== NPU/BPU Status ==="',
        'cat /sys/devices/system/bpu/bpu*/ratio 2>/dev/null && echo "(BPU load)" || echo "N/A"',
      ].join(' && ');
      return sshExec(config, cmd, 10_000, ctx);
    },
  };

  const deviceProcesses: Tool = {
    name: 'device_processes',
    description: 'List top processes by CPU/memory usage on the device.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of processes to show (default: 10)' },
      },
    },
    async execute(input, ctx) {
      const count = Math.max(1, Math.min(Number(input.count) || 10, 100));
      return sshExec(config, `ps aux --sort=-%cpu | head -${count + 1}`, 10_000, ctx);
    },
  };

  const deviceNetwork: Tool = {
    name: 'device_network',
    description: 'Get network interfaces and connectivity status of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== IP Addresses ==="',
        'ip -4 addr show | grep -E "inet " | awk \'{print $NF, $2}\'',
        'echo ""',
        'echo "=== Default Route ==="',
        'ip route | grep default',
        'echo ""',
        'echo "=== DNS ==="',
        'cat /etc/resolv.conf | grep nameserver',
        'echo ""',
        'echo "=== Internet Check ==="',
        'ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1 && echo "Online" || echo "Offline"',
      ].join(' && ');
      return sshExec(config, cmd, 10_000, ctx);
    },
  };

  const deviceCameras: Tool = {
    name: 'device_cameras',
    description: 'Enumerate camera devices and their supported formats (V4L2).',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== Video Devices ==="',
        'ls -la /dev/video* 2>/dev/null || echo "No video devices"',
        'echo ""',
        '[ -x "$(command -v v4l2-ctl)" ] || { echo "v4l2-ctl not installed"; exit 0; }',
        'for dev in /dev/video*; do',
        '  echo "=== $dev ==="',
        '  v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null | head -30 || echo "Unable to query device"',
        '  echo ""',
        'done',
      ].join(' ');
      return sshExec(config, cmd, 15_000, ctx);
    },
  };

  return [deviceTemperature, deviceResources, deviceProcesses, deviceNetwork, deviceCameras];
}
