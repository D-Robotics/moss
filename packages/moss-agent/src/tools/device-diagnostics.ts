







import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { wrapAsMoss, ErrorCode } from '../errors.js';
import { buildSshCommand, runSsh, sshBinFor, sshFailureToError } from './ssh-utils.js';
import type { DeviceConnectionHealth } from './device-connection-health.js';
import type { DeviceSshExecutor } from './device-ssh-session.js';

async function sshExec(
  config: DeviceSshConfig,
  cmd: string,
  timeout = 10_000,
  ctx?: ToolContext,
  health?: DeviceConnectionHealth,
  operation = 'device diagnostic',
  executor?: DeviceSshExecutor
): Promise<string> {
  await health?.beforeOperation(operation);

  try {
    const result = executor
      ? await executor.run(cmd, {
          timeout,
          maxBuffer: 1024 * 1024,
          signal: ctx?.abortSignal,
        })
      : await runSsh(config, buildSshCommand(config, cmd, 5), {
          timeout,
          maxBuffer: 1024 * 1024,
          signal: ctx?.abortSignal,
        });
    return result.stdout.trim();
  } catch (err) {
    await health?.handleFailure(err, { operation, abortSignal: ctx?.abortSignal });
    
    
    
    const sshError = sshFailureToError(err, sshBinFor(config));
    if (sshError) throw sshError;
    throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity and device power',
      recoverable: true,
    });
  }
}

export function createDeviceDiagnosticsTools(
  config: DeviceSshConfig,
  health?: DeviceConnectionHealth,
  executor?: DeviceSshExecutor
): Tool[] {
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
      return sshExec(config, cmd, 10_000, ctx, health, 'device_temperature', executor);
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
      return sshExec(config, cmd, 10_000, ctx, health, 'device_resources', executor);
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
      return sshExec(
        config,
        `ps aux --sort=-%cpu | head -${count + 1}`,
        10_000,
        ctx,
        health,
        'device_processes',
        executor
      );
    },
  };

  const deviceNetwork: Tool = {
    name: 'device_network',
    description: 'Get network interfaces and connectivity status of the device.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = [
        'echo "=== IP Addresses ==="',
        'ip -4 addr show | awk \'/inet / {print $NF, $2}\' || true',
        'echo ""',
        'echo "=== Default Route ==="',
        'ip route | grep default || echo "No default route"',
        'echo ""',
        'echo "=== DNS ==="',
        'grep nameserver /etc/resolv.conf 2>/dev/null || echo "No DNS nameserver configured"',
        'echo ""',
        'echo "=== Internet Check ==="',
        'ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1 && echo "Online" || echo "Offline"',
      ].join('; ');
      return sshExec(config, cmd, 10_000, ctx, health, 'device_network', executor);
    },
  };

  const deviceCameras: Tool = {
    name: 'device_cameras',
    description:
      'Discover USB/UVC and MIPI/CSI cameras, V4L2 video/subdevice nodes, media-controller topology, sensors, and supported formats.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const cmd = buildDeviceCamerasCommand();
      return sshExec(config, cmd, 15_000, ctx, health, 'device_cameras', executor);
    },
  };

  const deviceRoboticsStatus: Tool = {
    name: 'device_robotics_status',
    description:
      'Discover the connected robot development environment before acting: ROS1/ROS2, distributions and workspaces, USB/MIPI cameras, serial/CAN/I2C interfaces, accelerators, and common project roots.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      return sshExec(
        config,
        buildDeviceRoboticsStatusCommand(),
        20_000,
        ctx,
        health,
        'device_robotics_status',
        executor
      );
    },
  };

  return [
    deviceRoboticsStatus,
    deviceTemperature,
    deviceResources,
    deviceProcesses,
    deviceNetwork,
    deviceCameras,
  ];
}

export function buildDeviceRoboticsStatusCommand(): string {
  return [
    'echo "=== Robot Development Environment ==="',
    'echo "host: $(hostname)"',
    'echo "arch: $(uname -m)"',
    'echo "kernel: $(uname -r)"',
    'echo ""',
    'echo "=== ROS1 / ROS2 ==="',
    'printf "ROS_DISTRO: %s\\n" "${ROS_DISTRO:-not set}"',
    'command -v roscore >/dev/null 2>&1 && echo "ROS1: available ($(command -v roscore))" || echo "ROS1: not in current PATH"',
    'command -v ros2 >/dev/null 2>&1 && echo "ROS2: available ($(command -v ros2))" || echo "ROS2: not in current PATH"',
    'echo "installed setups:"',
    'for setup in /opt/tros/*/setup.bash /opt/ros/*/setup.bash "$HOME"/*/devel/setup.bash "$HOME"/*/install/setup.bash "$HOME"/*/*/devel/setup.bash "$HOME"/*/*/install/setup.bash; do [ -f "$setup" ] && echo "  $setup"; done',
    'echo ""',
    'echo "=== Cameras (USB/UVC + MIPI/CSI) ==="',
    'camera_found=0; for dev in /dev/video* /dev/v4l-subdev* /dev/media*; do [ -e "$dev" ] || continue; camera_found=1; echo "  $dev"; done; [ "$camera_found" -eq 1 ] || echo "  none found"',
    'echo ""',
    'echo "=== Robot Buses and Controllers ==="',
    'serial_found=0; for dev in /dev/ttyUSB* /dev/ttyACM* /dev/ttyS*; do [ -e "$dev" ] || continue; serial_found=1; echo "  serial: $dev"; done; [ "$serial_found" -eq 1 ] || echo "  serial: none found"',
    'if command -v ip >/dev/null 2>&1; then ip -details link show type can 2>/dev/null | sed "s/^/  CAN: /" || true; else echo "  CAN: ip tool unavailable"; fi',
    'i2c_found=0; for dev in /dev/i2c-*; do [ -e "$dev" ] || continue; i2c_found=1; echo "  I2C: $dev"; done; [ "$i2c_found" -eq 1 ] || echo "  I2C: none found"',
    'echo ""',
    'echo "=== Accelerator / Compute ==="',
    'for node in /dev/bpu* /dev/dri/render* /dev/nvidia* /sys/class/devfreq/*; do [ -e "$node" ] && echo "  accelerator: $node"; done',
    'command -v hrt_model_exec >/dev/null 2>&1 && echo "  BPU runtime: hrt_model_exec available" || true',
    'echo ""',
    'echo "=== Likely Workspaces ==="',
    'find "$HOME" /userdata -maxdepth 3 -type f \\( -name package.xml -o -name COLCON_IGNORE -o -name CMakeLists.txt \\) 2>/dev/null | sed "s#/[^/]*$##" | sort -u | head -40',
  ].join('\n');
}

export function buildDeviceCamerasCommand(): string {
  return [
    'echo "=== Camera Device Nodes (USB/UVC + MIPI/CSI) ==="',
    'found=0',
    'for dev in /dev/video* /dev/v4l-subdev* /dev/media*; do',
    '  [ -e "$dev" ] || continue',
    '  found=1',
    '  ls -la "$dev"',
    'done',
    '[ "$found" -eq 1 ] || echo "No video devices found (checked video, media, and V4L2 subdevice nodes)"',
    'echo ""',
    'echo "=== Media Controller Topology (MIPI sensors, CSI, ISP links) ==="',
    'if command -v media-ctl >/dev/null 2>&1; then',
    '  media_found=0',
    '  for media in /dev/media*; do',
    '    [ -e "$media" ] || continue',
    '    media_found=1',
    '    echo "--- $media ---"',
    '    media-ctl -d "$media" -p 2>&1 | head -120 || echo "Unable to query $media"',
    '  done',
    '  [ "$media_found" -eq 1 ] || echo "No media-controller nodes found"',
    'else',
    '  echo "media-ctl not installed (install v4l-utils to inspect MIPI/CSI topology)"',
    'fi',
    'echo ""',
    'echo "=== V4L2 Capture and Subdevice Details ==="',
    'if command -v v4l2-ctl >/dev/null 2>&1; then',
    '  for dev in /dev/video* /dev/v4l-subdev*; do',
    '    [ -e "$dev" ] || continue',
    '    echo "--- $dev ---"',
    '    v4l2-ctl -d "$dev" --all 2>&1 | head -45 || true',
    '    case "$dev" in /dev/video*) v4l2-ctl -d "$dev" --list-formats-ext 2>&1 | head -60 || true ;; esac',
    '  done',
    'else',
    '  echo "v4l2-ctl not installed"',
    'fi',
    'echo ""',
    'echo "=== Kernel Camera Sensors / CSI / MIPI Drivers ==="',
    'for node in /sys/class/video4linux/* /sys/bus/i2c/devices/*; do',
    '  [ -e "$node" ] || continue',
    '  name=$(cat "$node/name" 2>/dev/null || basename "$node")',
    '  case "$name $(readlink -f "$node/device/driver" 2>/dev/null)" in',
    '    *sensor*|*camera*|*csi*|*mipi*|*isp*|*imx*|*ov*|*gc*) echo "$(basename "$node"): $name driver=$(basename "$(readlink -f "$node/device/driver" 2>/dev/null)")" ;;',
    '  esac',
    '  echo ""',
    'done',
  ].join('\n');
}
