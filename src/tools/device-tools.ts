import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import type { DeviceConnection, DeviceTarget } from '../contracts/device.js';

const execFile = promisify(execFileCb);
import { errorMessage } from '../errors.js';
import { classifyDeviceOperation } from '../safety/device-risk.js';
import { permitDeviceOperation } from '../safety/device-trust.js';
import type { Tool } from '../core/tools/tool-types.js';
import { getDeviceConnection } from '../device/device-registry.js';
import {
  appendDeploymentRecord,
  formatDeploymentRecord,
  runDeployment,
} from '../device/deployment.js';
import { DEVICE_CREDENTIAL_RULE, DEVICE_PROBE_FIRST } from '../device/device-probe-prompt.js';
import {
  formatDeviceTarget,
  missingTargetHelp,
  resolveDefaultDeviceTarget,
} from '../device/device-target.js';
import {
  DEFAULT_SYNC_EXCLUDES,
  formatBytes,
  formatSyncPlan,
  listLocalWorkspaceFiles,
  parseRemoteFileListing,
  planWorkspaceSync,
  remoteFileListingCommand,
  shellQuote as syncShellQuote,
} from '../device/workspace-sync.js';
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
import { spillToolOutput } from './tool-output-spill.js';
import { presentToolOutput } from '../safety/tool-output-redact.js';
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
  'The device target comes from MOSS_DEVICE_HOST/PORT/USER/KIND plus MOSS_DEVICE_PASSWORD or MOSS_DEVICE_KEY (env / .env). ' +
  DEVICE_CREDENTIAL_RULE;

export const deviceInfoTool: Tool = {
  name: 'device_info',
  description:
    'Connect to the configured device (RDK board or Linux host) and report identity + system facts: hostname, OS, kernel, arch, CPU, memory, uptime, load. Also serves as the connectivity probe — call this first when the user asks about the board or device.\n' +
    DEVICE_PROBE_FIRST +
    '\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
    '- By default the command runs in ONE persistent shell per device: `cd`, `export` and `source` persist across calls, and the TROS/ROS overlay is sourced automatically the first time a ROS command needs it (reported as `ROS_ENV_SOURCED`). Pass persistent=false for a one-shot process.\n' +
    '- Prefer one focused command per call; prefer the read-only device_* tools for standard observation (info/processes/resources/temperature/files).\n' +
    '- Destructive or lockout-risk commands (reboot/shutdown, flashing, rm of system paths, writes to /boot or /etc, network changes, package removal, systemctl stop/disable/mask, ssh or account edits) stay gated even in full mode until the user confirms or opts into device trust.\n' +
    '- Start long-running/background processes with ALL fds redirected or the SSH channel hangs until the timeout: `nohup CMD > run.log 2>&1 < /dev/null & echo $! > run.pid; sleep 1; cat run.log`. Never bare `CMD &`. To stop one: `kill \"$(cat run.pid)\"`. A grep in a pipeline exiting 1 (no match) is NOT a failure — add `|| true` when you chain commands.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    leanDescription:
      'Run a shell command on the device (persistent shell, ROS auto-sourced); destructive ones gated. Not for observation.',
    // Not `discovery`: this is a mutation-capable tool, and the discovery
    // failure limit (2) is too tight for device work where a pipeline grep
    // exiting 1 is routine. The read-only device probes keep discovery.
    classification: {},
    maxResultTokens: 6_000,
    truncationHint: 'output was cut — narrow the remote command to the slice you need',
    sideEffectClass: 'device_mutation',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Host enforces the device safety policy via AgentHooks.onBeforeToolExec. Read-only and reversible mutations run in full mode; the destructive tier requires confirmation or an explicit trust grant (MOSS_DEVICE_TRUST, --trust-device, permissions.deviceTrust, trustedDevices, or an allow rule).',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute on the device' },
      persistent: {
        type: 'boolean',
        description:
          'Run inside the per-device persistent shell (default true). false = fresh one-shot process.',
      },
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
    if (!command.trim()) {
      return 'Error: device_exec needs a command. Nothing ran on the device — pass the shell command to execute.';
    }
    const classification = classifyDeviceOperation({
      toolName: 'device_exec',
      sideEffect: 'device_mutation',
      command,
      remoteUser: resolved.target.user,
    });
    if (
      classification &&
      !permitDeviceOperation(classification, 'device_exec', process.env, ctx.toolCallId)
    ) {
      return `Command blocked: ${classification.reason}`;
    }
    const requestedTimeout = Number(input.timeout_ms);
    // A non-positive value would reach the SSH exec as "no deadline"; treat it
    // as the caller forgetting to pass one instead.
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : EXEC_DEFAULT_TIMEOUT_MS;
    const conn = resolved.conn;
    const run: DeviceConnection['exec'] =
      input.persistent === false || !conn.execPersistent
        ? (cmd, opts) => conn.exec(cmd, opts)
        : (cmd, opts) => conn.execPersistent!(cmd, opts);
    try {
      const result = await run(command, {
        timeoutMs,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
      const stdoutRaw = result.stdout.trim();
      let outText = looksBinary(stdoutRaw)
        ? `(binary output, ${stdoutRaw.length} chars — suppressed; pipe through hexdump/xxd on the device if needed)`
        : stdoutRaw;
      if (!looksBinary(stdoutRaw) && outText.length > EXEC_STDOUT_MAX) {
        // Same egress filter as the visible result: the spill must not keep a
        // secret that the model-facing text would have masked.
        const spilled = spillToolOutput({
          workspaceDir: ctx.workspaceDir,
          toolName: 'device-exec',
          text: presentToolOutput({
            toolName: 'device_exec',
            input: { command },
            text: outText,
            workspaceDir: ctx.workspaceDir,
          }),
        });
        const head = outText.slice(0, Math.floor(EXEC_STDOUT_MAX * 0.7));
        const tail = outText.slice(-Math.floor(EXEC_STDOUT_MAX * 0.25));
        outText =
          `${head}\n\n... [${outText.length - EXEC_STDOUT_MAX} chars omitted] ...\n\n${tail}\n` +
          (spilled
            ? `(device stdout truncated to ~${EXEC_STDOUT_MAX} chars; full output: ${spilled} — read the omitted region from there)`
            : `(device stdout truncated to ~${EXEC_STDOUT_MAX} chars; re-run with a narrower command)`);
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
  metadata: {
    leanDescription:
      'Read a text file from the device over SFTP; device_exec for binaries. Not for local files.',
    classification: { singleCallExempt: true, discovery: true },
    maxResultTokens: 10_000,
    truncationHint: 'the dropped region is not in context — page it with offset/limit',
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
  async execute(input, ctx) {
    const resolved = await connectDefaultDevice('device_file_read');
    if (typeof resolved === 'string') return resolved;
    const path = String(input.path ?? '');
    const readRisk = classifyDeviceOperation({
      toolName: 'device_file_read',
      path,
      remoteUser: resolved.target.user,
    });
    if (
      readRisk &&
      !permitDeviceOperation(readRisk, 'device_file_read', process.env, ctx.toolCallId)
    ) {
      return `Command blocked: ${readRisk.reason}`;
    }
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
  metadata: {
    leanDescription:
      'List a directory on the device over SFTP. Not for local directories (list_directory).',
    classification: { singleCallExempt: true, discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
    leanDescription:
      'Write a file on the device over SFTP (parents must exist). Not for local files (write_file).',
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
    const writeRisk = classifyDeviceOperation({
      toolName: 'device_file_write',
      sideEffect: 'device_mutation',
      path: remotePath,
      remoteUser: resolved.target.user,
    });
    if (
      writeRisk &&
      !permitDeviceOperation(writeRisk, 'device_file_write', process.env, ctx.toolCallId)
    ) {
      return `Command blocked: ${writeRisk.reason}`;
    }
    let localAbs: string | undefined;
    if (input.content === undefined) {
      if (!input.local_path) {
        return 'Error: device_file_write requires content or local_path.';
      }
      try {
        localAbs = await safePath(String(input.local_path), ctx.workspaceDir, ctx.fileWriteRoots);
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
  metadata: {
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
  metadata: {
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
  metadata: {
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
    leanDescription:
      'Deploy an artifact as one recorded lifecycle. Not for file-only copies (device_file_write).',
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
      artifactAbs = await safePath(
        String(input.artifact_path ?? ''),
        ctx.workspaceDir,
        ctx.fileWriteRoots
      );
      await fs.access(artifactAbs);
    } catch (err) {
      return `Error: device_deploy artifact_path ${input.artifact_path}: ${errorMessage(err)}`;
    }
    const remotePath = String(input.remote_path ?? '');
    const deployRisk = classifyDeviceOperation({
      toolName: 'device_deploy',
      sideEffect: 'device_mutation',
      remotePath,
      startCommand: input.start_command ? String(input.start_command) : undefined,
      healthCommand: input.health_command ? String(input.health_command) : undefined,
      remoteUser: resolved.target.user,
    });
    if (
      deployRisk &&
      !permitDeviceOperation(deployRisk, 'device_deploy', process.env, ctx.toolCallId)
    ) {
      return `Command blocked: ${deployRisk.reason}`;
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
    'ROS commands themselves run through device_exec after verifying and sourcing <installation>/setup.bash (for example, `test -f /opt/tros/setup.bash && source /opt/tros/setup.bash`). If that file is absent, check the TROS manual and cite its page URL.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    leanDescription:
      'Detect the device TROS/ROS2 stack before ROS work. Not for general facts (device_probe).',
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
  metadata: {
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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
  metadata: {
    hiddenFromModel: true,
    classification: { discovery: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
  },
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

// One model-facing observation tool instead of seven empty-schema probes. The old
// names stay registered (subagent scopes, truncation budgets, old transcripts and
// SDK hosts reference them by name) but are no longer offered to the model.
const DEVICE_PROBES = {
  info: deviceInfoTool,
  processes: deviceProcessesTool,
  resources: deviceResourcesTool,
  temperature: deviceTemperatureTool,
  network: deviceNetworkTool,
  cameras: deviceCamerasTool,
  robotics_status: deviceRoboticsStatusTool,
} as const;

type DeviceProbeKind = keyof typeof DEVICE_PROBES;
const DEVICE_PROBE_KINDS = Object.keys(DEVICE_PROBES) as DeviceProbeKind[];

export const deviceProbeTool: Tool = {
  name: 'device_probe',
  description:
    'Read-only device observation over SSH. kind=info connects and reports identity/system facts (call this first); ' +
    'processes/resources/temperature/network/cameras/robotics_status return one structured snapshot each. ' +
    'Use these before device_exec for standard observation; they are readonly, parallel-safe and retried on transport errors.\n' +
    DEVICE_PROBE_FIRST +
    '\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    leanDescription:
      'Read-only device SSH observation (info/processes/resources/temperature/network/cameras); prefer over device_exec.',
    classification: { discovery: true, singleCallExempt: true },
    sideEffectClass: 'readonly',
    transientRetry: true,
    maxResultTokens: 6_000,
  },
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: DEVICE_PROBE_KINDS,
        description: 'Which observation to read. info is the connectivity probe.',
      },
    },
    required: ['kind'],
  },
  async execute(input, ctx) {
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    if (!DEVICE_PROBE_KINDS.includes(kind as DeviceProbeKind)) {
      return `Error: device_probe kind must be one of ${DEVICE_PROBE_KINDS.join('|')}.`;
    }
    return DEVICE_PROBES[kind as DeviceProbeKind].execute({}, ctx);
  },
};

/** Remote paths a sync may write to: absolute, and deep enough that a mirror cannot hit a system root. */
function assertSyncRemoteDir(remoteDir: string): string | null {
  if (!remoteDir.startsWith('/')) {
    return `Error: device_sync remote_dir must be an absolute path on the device (got ${remoteDir}).`;
  }
  const depth = remoteDir.split('/').filter(Boolean).length;
  if (depth < 2) {
    return `Error: device_sync refuses remote_dir=${remoteDir}: it must name a project directory at least two levels deep (e.g. /userdata/rdkstudio/projects/<id>), never a system root.`;
  }
  return null;
}

/** Join a relative file path under the remote root; refuse anything that escapes it. */
function remoteJoin(remoteDir: string, rel: string): string | null {
  const segments = rel.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return null;
  return `${remoteDir.replace(/\/+$/, '')}/${segments.join('/')}`;
}

export const deviceSyncTool: Tool = {
  name: 'device_sync',
  description:
    'Sync the local workspace (or a sub-directory) to a directory on the device in one call — the way `rsync`/`torq deploy`/cargo-device do it, instead of uploading files one by one. ' +
    'Compares local files with the remote listing by relative path + size, uploads only what changed through one tar stream, keeps executable bits, and (opt-in) deletes stale remote files. ' +
    'Build outputs, VCS data and caches (build/ install/ log/ .git/ node_modules/ __pycache__ …) are excluded by default. ' +
    'Use it whenever the task is "deploy / push / run this project on the board", then run the board-side step with device_exec.\n' +
    DEVICE_TOOLS_DESCRIPTION_NOTE,
  metadata: {
    leanDescription:
      'Sync the workspace to a device directory in one call (changed files only). Not for single files.',
    classification: {},
    maxResultTokens: 4_000,
    sideEffectClass: 'device_mutation',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Host must enforce approval via AgentHooks.onBeforeToolExec (device_mutation class); remote_dir is always a project directory, never a system root.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      remote_dir: {
        type: 'string',
        description: 'Absolute destination directory on the device (project root on the board)',
      },
      local_dir: {
        type: 'string',
        description: 'Workspace-relative source directory (default: the workspace root)',
      },
      delete_removed: {
        type: 'boolean',
        description:
          'Also delete remote files that no longer exist locally (mirror). Default false.',
      },
      excludes: {
        type: 'array',
        items: { type: 'string' },
        description: `Replace the default exclude list (${DEFAULT_SYNC_EXCLUDES.slice(0, 6).join(', ')} …). Segment names or *.ext.`,
      },
      max_file_mb: {
        type: 'number',
        description: 'Skip files above this size and report them (default 64).',
      },
      dry_run: { type: 'boolean', description: 'Only report what would change; transfer nothing.' },
      reason: {
        type: 'string',
        description:
          'One line on why this sync is needed for the task (shown to the user in the approval prompt)',
      },
    },
    required: ['remote_dir'],
  },
  async execute(input, ctx) {
    // Validate the target before touching the network: a bad remote_dir is a
    // caller error, not a device error, and must not cost a connect round trip.
    const remoteDir = String(input.remote_dir ?? '').trim();
    const dirError = assertSyncRemoteDir(remoteDir);
    if (dirError) return dirError;
    const resolved = await connectDefaultDevice('device_sync');
    if (typeof resolved === 'string') return resolved;
    let localAbs: string;
    try {
      localAbs = await safePath(
        String(input.local_dir ?? '.'),
        ctx.workspaceDir,
        ctx.fileWriteRoots
      );
      const stat = await fs.stat(localAbs);
      if (!stat.isDirectory()) {
        return `Error: device_sync local_dir ${input.local_dir} is not a directory.`;
      }
    } catch (err) {
      return `Error: device_sync local_dir ${input.local_dir}: ${errorMessage(err)}`;
    }
    const deleteRemoved = input.delete_removed === true;
    const risk = classifyDeviceOperation({
      toolName: 'device_sync',
      sideEffect: 'device_mutation',
      remotePath: remoteDir,
      remoteUser: resolved.target.user,
    });
    if (risk && !permitDeviceOperation(risk, 'device_sync', process.env, ctx.toolCallId)) {
      return `Command blocked: ${risk.reason}`;
    }
    const excludes =
      Array.isArray(input.excludes) && input.excludes.length > 0
        ? (input.excludes as unknown[]).map((e) => String(e).trim()).filter(Boolean)
        : DEFAULT_SYNC_EXCLUDES;
    const maxFileBytes =
      Number.isFinite(Number(input.max_file_mb)) && Number(input.max_file_mb) > 0
        ? Number(input.max_file_mb) * 1024 * 1024
        : undefined;
    const conn: DeviceConnection = resolved.conn;
    const signal = ctx.abortSignal ? { signal: ctx.abortSignal } : {};

    // 1. Remote listing (creates the directory on first sync).
    let remoteRaw: string;
    try {
      const listing = await conn.exec(
        `mkdir -p ${syncShellQuote(remoteDir)} && ${remoteFileListingCommand(remoteDir)}`,
        { timeoutMs: 60_000, ...signal }
      );
      remoteRaw = listing.stdout;
    } catch (err) {
      return deviceConnectionDown('device_sync', resolved.endpoint, err);
    }
    // 2. Plan.
    const [listing, remote] = await Promise.all([
      listLocalWorkspaceFiles(localAbs, excludes),
      Promise.resolve(parseRemoteFileListing(remoteRaw)),
    ]);
    const plan = planWorkspaceSync({
      local: listing.files,
      remote,
      excludes,
      deleteRemoved,
      maxFileBytes,
    });
    plan.excluded += listing.excluded;
    const staleCount = deleteRemoved
      ? plan.deletes.length
      : remote.filter((r) => !listing.files.some((l) => l.rel === r.rel)).length;
    const summary = formatSyncPlan(plan, { localDir: localAbs, remoteDir });
    if (input.dry_run === true) {
      return (
        `dry-run — nothing transferred.\n${summary}\n` +
        describeSyncChanges(plan, staleCount && !deleteRemoved ? staleCount : 0)
      );
    }
    if (plan.uploads.length === 0 && plan.deletes.length === 0) {
      return (
        `Already in sync.\n${summary}\n` +
        describeSyncChanges(plan, staleCount && !deleteRemoved ? staleCount : 0)
      );
    }

    // 3. Transfer the uploads as one tar stream (one SFTP round trip).
    const uploaded: string[] = [];
    const failed: string[] = [];
    if (plan.uploads.length > 0) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-device-sync-'));
      const tarPath = path.join(tmpDir, 'payload.tgz');
      const listPath = path.join(tmpDir, 'files.txt');
      const remoteTar = `${remoteDir.replace(/\/+$/, '')}/.moss-sync-${Date.now().toString(36)}.tgz`;
      try {
        // NUL-separated so a name with a newline or backslash cannot shift the list.
        await fs.writeFile(listPath, plan.uploads.map((f) => f.rel).join('\0') + '\0');
        await execFile('tar', ['--null', '-czf', tarPath, '-C', localAbs, '-T', listPath], {
          timeout: 120_000,
        });
        await conn.writeFile(remoteTar, { localPath: tarPath, ...signal });
        const extract = await conn.exec(
          `tar -xzf ${syncShellQuote(remoteTar)} -C ${syncShellQuote(remoteDir)}; __rc=$?; rm -f ${syncShellQuote(remoteTar)}; exit $__rc`,
          { timeoutMs: 120_000, ...signal }
        );
        if (extract.exitCode !== 0) {
          return `Error: device_sync extract failed on ${resolved.endpoint} (exit ${extract.exitCode}): ${extract.stdout.trim().slice(0, 500)}`;
        }
        uploaded.push(...plan.uploads.map((f) => f.rel));
        const executables = plan.uploads.filter((f) => f.executable).map((f) => f.rel);
        if (executables.length > 0) {
          const chmodCmds = executables.map((rel) =>
            syncShellQuote(remoteJoin(remoteDir, rel) ?? rel)
          );
          await conn.exec(`chmod +x ${chmodCmds.join(' ')}`, { timeoutMs: 30_000, ...signal });
        }
      } catch (err) {
        failed.push(errorMessage(err));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // 4. Deletions (mirror mode), strictly inside remote_dir.
    const deleted: string[] = [];
    if (plan.deletes.length > 0) {
      const targets = plan.deletes
        .map((rel) => remoteJoin(remoteDir, rel))
        .filter((p): p is string => Boolean(p));
      if (targets.length > 0) {
        await conn.exec(`rm -f -- ${targets.map(syncShellQuote).join(' ')}`, {
          timeoutMs: 30_000,
          ...signal,
        });
        deleted.push(...plan.deletes);
      }
    }

    const head = [summary];
    if (uploaded.length) {
      head.push(
        `uploaded (${uploaded.length}): ${uploaded.slice(0, 40).join(', ')}${uploaded.length > 40 ? ', …' : ''}`
      );
    }
    if (deleted.length)
      head.push(`deleted (${deleted.length}): ${deleted.slice(0, 20).join(', ')}`);
    if (staleCount && !deleteRemoved) {
      head.push(
        `${staleCount} remote file(s) exist only on the device and were kept (pass delete_removed=true to mirror).`
      );
    }
    if (plan.skippedLarge.length) {
      head.push(
        'skipped (size cap): ' +
          plan.skippedLarge.map((f) => `${f.rel} (${formatBytes(f.sizeBytes)})`).join(', ')
      );
    }
    if (failed.length) {
      return `Error: device_sync failed on ${resolved.endpoint}: ${failed.join('; ')}\n${head.join('\n')}`;
    }
    return head.join('\n');
  },
};

function describeSyncChanges(
  plan: { uploads: { rel: string; sizeBytes: number }[]; deletes: string[] },
  staleKept: number
): string {
  const lines: string[] = [];
  if (plan.uploads.length) {
    lines.push(
      `would upload (${plan.uploads.length}): ${plan.uploads
        .slice(0, 40)
        .map((f) => `${f.rel} (${formatBytes(f.sizeBytes)})`)
        .join(', ')}${plan.uploads.length > 40 ? ', …' : ''}`
    );
  }
  if (plan.deletes.length)
    lines.push(`would delete (${plan.deletes.length}): ${plan.deletes.slice(0, 20).join(', ')}`);
  if (staleKept > 0)
    lines.push(
      `${staleKept} remote file(s) exist only on the device and would be kept (delete_removed=false).`
    );
  return lines.join('\n');
}

export const deviceTools: Tool[] = [
  deviceInfoTool,
  deviceExecTool,
  deviceSyncTool,
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
  deviceProbeTool,
];
