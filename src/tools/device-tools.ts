import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeviceConnection, DeviceTarget } from '../contracts/device.js';
import { errorMessage } from '../errors.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import type { Tool } from '../core/tools/tool-types.js';
import { getDeviceConnection } from '../device/device-registry.js';
import {
  appendDeploymentRecord,
  formatDeploymentRecord,
  runDeployment,
} from '../device/deployment.js';
import {
  formatDeviceTarget,
  missingTargetHelp,
  resolveDefaultDeviceTarget,
} from '../device/device-target.js';
import {
  INFO_PROBE_SCRIPT,
  PROCESSES_PROBE_SCRIPT,
  RESOURCES_PROBE_SCRIPT,
  ROBOTICS_PROBE_SCRIPT,
  TEMPERATURE_PROBE_SCRIPT,
  NETWORK_PROBE_SCRIPT,
  CAMERAS_PROBE_SCRIPT,
  formatInfoSnapshot,
  formatProcessList,
  formatResourceSnapshot,
  formatRoboticsSnapshot,
  formatTemperatureSnapshot,
  formatNetworkSnapshot,
  formatCamerasSnapshot,
  parseInfoProbe,
  parseProcessesProbe,
  parseResourcesProbe,
  parseRoboticsProbe,
  parseTemperatureProbe,
  parseNetworkProbe,
  parseCamerasProbe,
} from '../device/observation.js';
import { EXEC_DEFAULT_TIMEOUT_MS, looksBinary, safePath } from './tool-helpers.js';
import { findLatestLiveTaskSnapshot, tryAppendTaskEvent } from '../core/task/task-store.js';

const EXEC_STDOUT_MAX = 80_000;
const EXEC_STDERR_MAX = 4_096;

interface ResolvedDevice {
  conn: DeviceConnection;
  target: DeviceTarget;
  endpoint: string;
}

/**
 * Resolve the default device target and ensure a live connection. Failures
 * return tool-result strings (prefix `Error:`) so failure gates see them —
 * the same convention as the exec tool.
 */
async function connectDefaultDevice(toolName: string): Promise<ResolvedDevice | string> {
  const target = resolveDefaultDeviceTarget();
  if (!target) return missingTargetHelp(toolName);
  try {
    const conn = await getDeviceConnection(target);
    return { conn, target, endpoint: formatDeviceTarget(target) };
  } catch (err) {
    return `Error: ${toolName}: ${errorMessage(err)}`;
  }
}

function deviceConnectionDown(toolName: string, endpoint: string, err: unknown): string {
  return (
    `Error: ${toolName}: device ${endpoint} connection failed: ${errorMessage(err)}\n` +
    `(hint: the connection may have dropped; retrying reconnects automatically)`
  );
}

const DEVICE_TOOLS_DESCRIPTION_NOTE =
  'The device target comes from MOSS_DEVICE_HOST/PORT/USER/KIND plus MOSS_DEVICE_PASSWORD or MOSS_DEVICE_KEY (env / .env).';

export const deviceInfoTool: Tool = {
  name: 'device_info',
  description:
    'Connect to the configured device (RDK board or Linux host) and report identity + system facts: hostname, OS, kernel, arch, CPU, memory, uptime, load. Also serves as the connectivity probe — call this first when starting device work.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_info');
    if (typeof resolved === 'string') return resolved;
    let stdout: string;
    try {
      const result = await resolved.conn.exec(INFO_PROBE_SCRIPT, { timeoutMs: 30_000 });
      stdout = result.stdout;
    } catch (err) {
      return deviceConnectionDown('device_info', resolved.endpoint, err);
    }
    const snapshot = parseInfoProbe(stdout, resolved.target);
    return formatInfoSnapshot(snapshot, resolved.endpoint);
  },
};

export const deviceExecTool: Tool = {
  name: 'device_exec',
  description:
    'Execute a shell command on the configured remote device (RDK board / Linux host) over SSH and return stdout + stderr with the exit code. Use for device-side work: builds, service control, diagnostics, ROS commands.\n' +
    '- Prefer one focused command per call; prefer the read-only device_* tools for standard observation (info/processes/resources/temperature/files).\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    sideEffectClass: 'device_mutation',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Host must enforce approval via AgentHooks.onBeforeToolExec (device_mutation class). Unattended device commands require an explicit autonomous policy.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute on the device' },
      timeout_ms: {
        type: 'number',
        description: `Timeout in ms (default ${EXEC_DEFAULT_TIMEOUT_MS}).`,
      },
      reason: {
        type: 'string',
        description:
          'One line on why this device mutation is needed for the task (shown to the user in the approval prompt)',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    const resolved = await connectDefaultDevice('device_exec');
    if (typeof resolved === 'string') return resolved;
    const command = String(input.command ?? '');
    const safetyCheck = isCommandDangerous(command);
    if (safetyCheck.blocked) {
      return `Command blocked: ${safetyCheck.reason}`;
    }
    const timeoutMs = Number(input.timeout_ms) || EXEC_DEFAULT_TIMEOUT_MS;
    try {
      const result = await resolved.conn.exec(command, {
        timeoutMs,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
      const stdoutRaw = result.stdout.trim();
      let outText = looksBinary(stdoutRaw)
        ? `(binary output, ${stdoutRaw.length} chars — suppressed; pipe through hexdump/xxd on the device if needed)`
        : stdoutRaw;
      if (!looksBinary(stdoutRaw) && outText.length > EXEC_STDOUT_MAX) {
        const head = outText.slice(0, Math.floor(EXEC_STDOUT_MAX * 0.7));
        const tail = outText.slice(-Math.floor(EXEC_STDOUT_MAX * 0.25));
        outText =
          `${head}\n\n... [${outText.length - EXEC_STDOUT_MAX} chars omitted] ...\n\n${tail}\n` +
          `(device stdout truncated to ~${EXEC_STDOUT_MAX} chars; re-run with a narrower command)`;
      }
      const stderrRaw = result.stderr.trim();
      const stderrFmt = stderrRaw
        ? stderrRaw.length > EXEC_STDERR_MAX
          ? `--- stderr (truncated ${stderrRaw.length}→${EXEC_STDERR_MAX} chars) ---\n${stderrRaw.slice(0, EXEC_STDERR_MAX)}`
          : `--- stderr ---\n${stderrRaw}`
        : '';
      if (result.timedOut) {
        return (
          `Command failed (device timeout after ${timeoutMs}ms):\n${outText || '(no output)'}\n\n` +
          `(hint: raise timeout_ms; for long-running device processes run them with nohup and poll with device_exec)`
        );
      }
      const exitNote =
        result.exitCode !== null && result.exitCode !== 0 ? `exit_code: ${result.exitCode}\n` : '';
      return [exitNote + (outText || '(no output)'), stderrFmt].filter(Boolean).join('\n\n');
    } catch (err) {
      return `Command failed (device ${resolved.endpoint}): ${errorMessage(err)}`;
    }
  },
};

export const deviceFileReadTool: Tool = {
  name: 'device_file_read',
  description:
    'Read a text file from the configured device over SFTP. Returns the file content (use device_exec for binaries or huge files).\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path on the device' },
      max_bytes: {
        type: 'number',
        description: 'Read cap in bytes (default 262144).',
      },
    },
    required: ['path'],
  },
  async execute(input) {
    const resolved = await connectDefaultDevice('device_file_read');
    if (typeof resolved === 'string') return resolved;
    try {
      const content = await resolved.conn.readFile(String(input.path ?? ''), {
        maxBytes: Number(input.max_bytes) || undefined,
      });
      if (!content) return '(empty file)';
      if (looksBinary(content)) {
        return `(binary file, ${content.length} chars — suppressed; inspect on the device with hexdump/xxd via device_exec)`;
      }
      return content;
    } catch (err) {
      return `Error: device_file_read ${input.path}: ${errorMessage(err)}`;
    }
  },
};

export const deviceFileListTool: Tool = {
  name: 'device_file_list',
  description:
    'List one directory on the configured device over SFTP (names, types, sizes).\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute directory path on the device' },
    },
    required: ['path'],
  },
  async execute(input) {
    const resolved = await connectDefaultDevice('device_file_list');
    if (typeof resolved === 'string') return resolved;
    try {
      const entries = await resolved.conn.listDir(String(input.path ?? ''));
      if (entries.length === 0) return '(empty directory)';
      const rows = entries.slice(0, 400).map((e) => {
        const suffix = e.type === 'dir' ? '/' : e.type === 'symlink' ? '@' : '';
        const size = e.type === 'file' && e.sizeBytes !== undefined ? ` (${e.sizeBytes}B)` : '';
        return `${e.name}${suffix}${size}`;
      });
      const note = entries.length > 400 ? `\n(${entries.length - 400} more entries omitted)` : '';
      return `${resolved.endpoint}:${input.path} — ${entries.length} entries\n${rows.join('\n')}${note}`;
    } catch (err) {
      return `Error: device_file_list ${input.path}: ${errorMessage(err)}`;
    }
  },
};

export const deviceFileWriteTool: Tool = {
  name: 'device_file_write',
  description:
    'Write a file on the configured device over SFTP — either inline content or by uploading a local workspace file (artifact deploy). Parent directories must already exist (create them with device_exec mkdir -p first).\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    sideEffectClass: 'device_mutation',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Host must enforce approval via AgentHooks.onBeforeToolExec (device_mutation class).',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute destination path on the device' },
      content: {
        type: 'string',
        description: 'Text content to write (omit when using local_path)',
      },
      local_path: {
        type: 'string',
        description: 'Workspace-relative (or in-workspace absolute) local file to upload',
      },
      reason: {
        type: 'string',
        description:
          'One line on why this device file change is needed for the task (shown to the user in the approval prompt)',
      },
      mode: {
        type: 'number',
        description: 'Unix permission bits as a decimal (e.g. 493 = 0o755).',
      },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const resolved = await connectDefaultDevice('device_file_write');
    if (typeof resolved === 'string') return resolved;
    const remotePath = String(input.path ?? '');
    let localAbs: string | undefined;
    if (input.content === undefined) {
      if (!input.local_path) {
        return 'Error: device_file_write requires content or local_path.';
      }
      try {
        localAbs = await safePath(String(input.local_path), ctx.workspaceDir);
        await fs.access(localAbs);
      } catch (err) {
        return `Error: device_file_write local_path ${input.local_path}: ${errorMessage(err)}`;
      }
    }
    const mode =
      typeof input.mode === 'number' && Number.isInteger(input.mode) && input.mode > 0
        ? input.mode
        : undefined;
    try {
      await resolved.conn.writeFile(remotePath, {
        ...(input.content !== undefined ? { content: String(input.content) } : {}),
        ...(localAbs ? { localPath: localAbs } : {}),
        ...(mode !== undefined ? { mode } : {}),
      });
    } catch (err) {
      return `Error: device_file_write ${remotePath}: ${errorMessage(err)}`;
    }
    const source = localAbs
      ? `uploaded ${path.relative(ctx.workspaceDir, localAbs) || localAbs} (${(await fs.stat(localAbs)).size} bytes)`
      : `wrote ${String(input.content ?? '').length} chars`;
    return `Wrote ${remotePath} on ${resolved.endpoint} — ${source}.`;
  },
};

export const deviceProcessesTool: Tool = {
  name: 'device_processes',
  description:
    'List the top processes on the configured device (pid, user, CPU%, MEM%, RSS, command), sorted by CPU.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_processes');
    if (typeof resolved === 'string') return resolved;
    try {
      const result = await resolved.conn.exec(PROCESSES_PROBE_SCRIPT, { timeoutMs: 20_000 });
      return formatProcessList(
        parseProcessesProbe(result.stdout, resolved.target.deviceId),
        resolved.endpoint
      );
    } catch (err) {
      return deviceConnectionDown('device_processes', resolved.endpoint, err);
    }
  },
};

export const deviceResourcesTool: Tool = {
  name: 'device_resources',
  description:
    'Report memory, load average, and per-mount disk usage on the configured device.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_resources');
    if (typeof resolved === 'string') return resolved;
    try {
      const result = await resolved.conn.exec(RESOURCES_PROBE_SCRIPT, { timeoutMs: 20_000 });
      return formatResourceSnapshot(
        parseResourcesProbe(result.stdout, resolved.target.deviceId),
        resolved.endpoint
      );
    } catch (err) {
      return deviceConnectionDown('device_resources', resolved.endpoint, err);
    }
  },
};

export const deviceTemperatureTool: Tool = {
  name: 'device_temperature',
  description:
    'Read thermal zones (°C) from /sys/class/thermal on the configured device — the first check when diagnosing throttling or stability issues.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_temperature');
    if (typeof resolved === 'string') return resolved;
    try {
      const result = await resolved.conn.exec(TEMPERATURE_PROBE_SCRIPT, { timeoutMs: 20_000 });
      return formatTemperatureSnapshot(
        parseTemperatureProbe(result.stdout, resolved.target.deviceId)
      );
    } catch (err) {
      return deviceConnectionDown('device_temperature', resolved.endpoint, err);
    }
  },
};

export const deviceDeployTool: Tool = {
  name: 'device_deploy',
  description:
    'Deploy a workspace artifact to the configured device as one recorded lifecycle: mkdir → SFTP upload → (chmod +x) → (start command) → (health check). The full record is appended to .moss/deployments.jsonl — a deploy only reports success when every requested step passed (health check included).\n' +
    `- artifact_path must live inside the workspace.\n` +
    `- start_command: how to launch on the device (e.g. a systemd restart or nohup invocation). Omit for file-only deploys.\n` +
    `- health_command: device command proving the deployment is alive (exit 0 required); health_expect: optional regex its output must match.\n` +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    sideEffectClass: 'device_mutation',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Host must enforce approval via AgentHooks.onBeforeToolExec (device_mutation class).',
  },
  inputSchema: {
    type: 'object',
    properties: {
      artifact_path: { type: 'string', description: 'Workspace-relative artifact path to deploy' },
      remote_path: { type: 'string', description: 'Absolute destination path on the device' },
      executable: { type: 'boolean', description: 'chmod +x the artifact on the device' },
      start_command: {
        type: 'string',
        description: 'Device command that starts the artifact (optional)',
      },
      health_command: {
        type: 'string',
        description: 'Device command proving the deployment is alive (optional)',
      },
      health_expect: {
        type: 'string',
        description: 'Regex the health command output must match (optional)',
      },
      task_id: {
        type: 'string',
        description: 'Task this deployment belongs to (default: latest live task)',
      },
      reason: {
        type: 'string',
        description:
          'One line on why this deployment is needed for the task (shown to the user in the approval prompt)',
      },
      timeout_ms: { type: 'number', description: 'Per-step timeout in ms (default 60000)' },
    },
    required: ['artifact_path', 'remote_path'],
  },
  async execute(input, ctx) {
    const resolved = await connectDefaultDevice('device_deploy');
    if (typeof resolved === 'string') return resolved;
    let artifactAbs: string;
    try {
      artifactAbs = await safePath(String(input.artifact_path ?? ''), ctx.workspaceDir);
      await fs.access(artifactAbs);
    } catch (err) {
      return `Error: device_deploy artifact_path ${input.artifact_path}: ${errorMessage(err)}`;
    }
    const record = await runDeployment(
      resolved.conn,
      {
        artifactPath: artifactAbs,
        remotePath: String(input.remote_path ?? ''),
        ...(input.executable === true ? { executable: true } : {}),
        ...(input.start_command ? { startCommand: String(input.start_command) } : {}),
        ...(input.health_command ? { healthCommand: String(input.health_command) } : {}),
        ...(input.health_expect ? { healthExpect: String(input.health_expect) } : {}),
        ...(input.timeout_ms ? { timeoutMs: Number(input.timeout_ms) } : {}),
      },
      ctx.abortSignal ? { signal: ctx.abortSignal } : {}
    );
    // Task OS M4: deployments are timeline-visible events of the task they
    // serve (explicit task_id, or the latest live task in the workspace). The
    // association rides on the record itself so every consumer (TUI detail,
    // history, /deployments) sees the same ownership, not just the timeline.
    const owningTaskId =
      typeof input.task_id === 'string' && input.task_id.trim()
        ? input.task_id.trim()
        : (await findLatestLiveTaskSnapshot(ctx.workspaceDir))?.taskId;
    if (owningTaskId) record.taskId = owningTaskId;
    try {
      await appendDeploymentRecord(ctx.workspaceDir, record);
    } catch {
      // Persistence failure must not mask the deployment outcome; the record
      // is still returned to the model in full.
    }
    if (record.taskId) {
      await tryAppendTaskEvent(ctx.workspaceDir, record.taskId, 'deployment_recorded', {
        deploymentId: record.deploymentId,
        deviceId: record.deviceId,
        remotePath: record.remotePath,
        status: record.status,
      }).catch(() => undefined);
    }
    const text = formatDeploymentRecord(record);
    return record.status === 'failed'
      ? `Error: device_deploy failed — see steps below.\n${text}`
      : text;
  },
};

export const deviceRoboticsStatusTool: Tool = {
  name: 'device_robotics_status',
  description:
    'Detect the robotics stack on the configured device: TROS (/opt/tros, D-Robotics RDK) or upstream ROS2 (/opt/ros/<distro>) installations, the ros2 binary path, TROS version, and hbm presence. Call this before any ROS work — on a plain Linux host it reports "none detected" so you do not chase missing tools.\n' +
    'ROS commands themselves run through device_exec after sourcing the setup (e.g. `source /opt/tros/setup.bash && ros2 node list`).\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_robotics_status');
    if (typeof resolved === 'string') return resolved;
    try {
      const result = await resolved.conn.exec(ROBOTICS_PROBE_SCRIPT, { timeoutMs: 20_000 });
      return formatRoboticsSnapshot(
        parseRoboticsProbe(result.stdout, resolved.target.deviceId),
        resolved.endpoint
      );
    } catch (err) {
      return deviceConnectionDown('device_robotics_status', resolved.endpoint, err);
    }
  },
};

export const deviceNetworkTool: Tool = {
  name: 'device_network',
  description:
    'Report the network state of the configured device: interfaces with link state, global addresses (inet/inet6), and the default route. First stop when diagnosing connectivity to a robot.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_network');
    if (typeof resolved === 'string') return resolved;
    try {
      const result = await resolved.conn.exec(NETWORK_PROBE_SCRIPT, { timeoutMs: 20_000 });
      return formatNetworkSnapshot(
        parseNetworkProbe(result.stdout, resolved.target.deviceId),
        resolved.endpoint
      );
    } catch (err) {
      return deviceConnectionDown('device_network', resolved.endpoint, err);
    }
  },
};

export const deviceCamerasTool: Tool = {
  name: 'device_cameras',
  description:
    'Enumerate v4l2 camera devices on the configured device (/sys/class/video4linux names + /dev/video* nodes). On RDK boards sensor names appear here — use before any camera/pipeline debugging.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: { sideEffectClass: 'readonly', transientRetry: true },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const resolved = await connectDefaultDevice('device_cameras');
    if (typeof resolved === 'string') return resolved;
    try {
      const result = await resolved.conn.exec(CAMERAS_PROBE_SCRIPT, { timeoutMs: 20_000 });
      return formatCamerasSnapshot(
        parseCamerasProbe(result.stdout, resolved.target.deviceId),
        resolved.endpoint
      );
    } catch (err) {
      return deviceConnectionDown('device_cameras', resolved.endpoint, err);
    }
  },
};

export const deviceTools: Tool[] = [
  deviceInfoTool,
  deviceExecTool,
  deviceFileReadTool,
  deviceFileListTool,
  deviceFileWriteTool,
  deviceDeployTool,
  deviceProcessesTool,
  deviceResourcesTool,
  deviceTemperatureTool,
  deviceRoboticsStatusTool,
  deviceNetworkTool,
  deviceCamerasTool,
];
