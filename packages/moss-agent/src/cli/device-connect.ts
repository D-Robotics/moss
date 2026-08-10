import type { MossAgent } from '../core/index.js';
import { createDeviceDiagnosticsTools } from '../tools/device-diagnostics.js';
import { createRos2Tools } from '../tools/device-ros2.js';
import {
  createDeviceSshTools,
  probeDeviceSsh,
  type DeviceSshConfig,
  type DeviceSshProbeResult,
} from '../tools/device-ssh.js';
import {
  BOARD_REPLACED_TOOL_NAMES,
  BOARD_SUSPENDED_TOOL_NAMES,
  createBoardWorkspaceTools,
} from '../tools/device-workspace.js';
import type { CliRuntimeStatus, CliDeviceSessionHandle } from './onboarding.js';
import { DeviceConnectionHealth } from '../tools/device-connection-health.js';
import { DeviceSshSession } from '../tools/device-ssh-session.js';
import { probeDeviceEnvironmentFacts } from '../memory/environment-fingerprint.js';
import { createRos1Tools } from '../tools/device-ros1.js';
import { isZhLocale as isZh } from './cli-locale.js';

const CONNECT_USAGE =
  'Usage: /connect <[user@]board-ip-or-hostname> [--user root] [--port 22] [--key ~/.ssh/id_rsa] [--password <pw>] [--no-verify] [--hybrid]\n' +
  'The host and credentials default to MOSS_DEVICE_HOST / MOSS_DEVICE_USER / MOSS_DEVICE_PORT / MOSS_DEVICE_KEY / MOSS_DEVICE_PASSWORD when omitted.\n' +
  'By default the session enters BOARD MODE (exec/file tools run on the board); --hybrid keeps local tools and only adds device_*/ros2_* tools. --no-verify skips the hostname probe but still establishes the persistent SSH session.';

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface ParsedDeviceConnectArgs {
  config?: DeviceSshConfig;

  verify?: boolean;

  mode?: 'board' | 'hybrid';
  error?: string;
}

export function parseDeviceConnectArgs(
  raw: string,
  env: NodeJS.ProcessEnv = process.env
): ParsedDeviceConnectArgs {
  const args = raw.trim().split(/\s+/).filter(Boolean);

  let target = '';
  let user = env.MOSS_DEVICE_USER || 'root';
  let port = parsePort(env.MOSS_DEVICE_PORT) ?? 22;
  let keyPath = env.MOSS_DEVICE_KEY;
  let password = env.MOSS_DEVICE_PASSWORD;
  let verify = env.MOSS_DEVICE_NO_VERIFY !== '1' && env.MOSS_DEVICE_NO_VERIFY !== 'true';
  let mode: 'board' | 'hybrid' =
    env.MOSS_DEVICE_HYBRID === '1' || env.MOSS_DEVICE_HYBRID === 'true' ? 'hybrid' : 'board';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--user' || arg === '-u') {
      user = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      port = parsePort(args[++i]) ?? port;
      continue;
    }
    if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length)) ?? port;
      continue;
    }
    if (arg === '--key') {
      keyPath = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--key=')) {
      keyPath = arg.slice('--key='.length);
      continue;
    }
    if (arg === '--password') {
      password = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
      continue;
    }
    if (arg === '--no-verify') {
      verify = false;
      continue;
    }
    if (arg === '--hybrid') {
      mode = 'hybrid';
      continue;
    }
    if (arg === '--board') {
      mode = 'board';
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `Unsupported /connect option: ${arg}\n${CONNECT_USAGE}` };
    }
    if (target) return { error: `Unexpected /connect argument: ${arg}\n${CONNECT_USAGE}` };
    target = arg;
  }

  if (!target) target = env.MOSS_DEVICE_HOST || '';
  if (!target) {
    return { error: CONNECT_USAGE };
  }
  if (target.includes('@')) {
    const [rawUser, rawHost] = target.split('@', 2);
    if (rawUser) user = rawUser;
    target = rawHost || target;
  }
  if (!target.trim()) return { error: 'Board host is empty.' };

  return {
    config: {
      host: target.trim(),
      user: user || 'root',
      port,
      ...(password ? { password } : {}),
      ...(keyPath ? { keyPath } : {}),
    },
    verify,
    mode,
  };
}

export interface ConnectDeviceOptions {
  skipVerify?: boolean;

  probe?: (config: DeviceSshConfig) => Promise<DeviceSshProbeResult>;

  mode?: 'board' | 'hybrid';

  locale?: string;
}

export interface DeviceConnectResult {
  ok: boolean;
  message: string;

  retryInput?: string;
}

function buildRetryCommand(config: DeviceSshConfig): string {
  const port = config.port && config.port !== 22 ? ` --port ${config.port}` : '';
  return `/connect ${config.user || 'root'}@${config.host}${port} --password `;
}

function buildConnectFailureMessage(
  config: DeviceSshConfig,
  probe: DeviceSshProbeResult,
  locale: string | undefined,
  options: { skippedPreflight?: boolean } = {}
): { message: string; retryInput?: string } {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  const zh = isZh(locale);
  const retry = buildRetryCommand(config);

  if (probe.kind === 'auth') {
    const message = zh
      ? [
          `[device] 连接 ${target} 失败：认证被拒（未提供密码，或密码/密钥不对）。设备工具未启用。`,
          `下一步：补上板卡密码重试（命令已为你预填）：`,
          `  ${retry}<密码>`,
          `免密方案：终端执行 ssh-copy-id ${config.user || 'root'}@${config.host} 配置一次，以后 /connect 无需密码。`,
        ].join('\n')
      : [
          `[device] Connection to ${target} FAILED: authentication rejected (no password given, or wrong password/key). Device tools were not enabled.`,
          `Next step — add the board password and retry (command pre-filled for you):`,
          `  ${retry}<password>`,
          `Passwordless option: run ssh-copy-id ${config.user || 'root'}@${config.host} once, then /connect needs no flags.`,
        ].join('\n');
    return { message, retryInput: retry };
  }

  const hints: Record<string, { zh: string; en: string }> = {
    refused: {
      zh: `板卡拒绝了端口 ${config.port || 22} 的连接：检查端口号（--port）以及板卡上 sshd 是否在运行。`,
      en: probe.detail,
    },
    unreachable: {
      zh: `无法到达 ${config.host}：检查 IP 是否正确、板卡是否开机、与本机是否同一网络。`,
      en: probe.detail,
    },
    dns: {
      zh: `无法解析主机名 ${config.host}：检查拼写，或直接使用板卡 IP。`,
      en: probe.detail,
    },
  };
  const hint =
    probe.kind && hints[probe.kind]
      ? zh
        ? hints[probe.kind].zh
        : hints[probe.kind].en
      : probe.detail;
  const retryHint = options.skippedPreflight
    ? zh
      ? `检查网络与 SSH 服务后重试：/connect ${config.user || 'root'}@${config.host}（可加 --port/--password/--key）。--no-verify 只跳过预检查，仍必须建立 SSH 连接。`
      : 'Check the network and SSH service, then retry with explicit credentials if needed. --no-verify skips only the preflight probe; it cannot bypass establishing the SSH connection.'
    : zh
      ? `排查后重试：/connect ${config.user || 'root'}@${config.host}（可加 --port/--password/--key；跳过预检查用 --no-verify）。`
      : 'Retry with explicit credentials (e.g. /connect user@ip --port 22 --password <pw>). To skip the separate preflight probe, use --no-verify; Moss still must establish the persistent SSH connection.';
  const message = zh
    ? [`[device] 连接 ${target} 失败，设备工具未启用。`, hint, retryHint].join('\n')
    : [
        `[device] Connection to ${target} FAILED — device tools were not enabled.`,
        hint,
        retryHint,
      ].join('\n');
  return { message };
}

export function formatDeviceConnectProgress(config: DeviceSshConfig, skipVerify = false): string {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  return skipVerify
    ? `[device] Establishing persistent SSH to ${target} (preflight probe skipped) ...`
    : `[device] Checking SSH and establishing a persistent session to ${target} ...`;
}

export function formatDeviceConnectFailure(
  config: DeviceSshConfig,
  probe: DeviceSshProbeResult,
  options: { locale?: string; skippedPreflight?: boolean } = {}
): { message: string; retryInput?: string } {
  return buildConnectFailureMessage(config, probe, options.locale, {
    skippedPreflight: options.skippedPreflight,
  });
}

function buildBoardModePromptLayer(target: string, hostname: string | undefined): string {
  return [
    '## Board Mode Active',
    `This session is connected to ${target}${hostname ? ` (remote hostname: ${hostname})` : ''}.`,
    'The default workspace tools — exec, read_file, write_file, edit_file, list_directory, search_files, search_code, move_file — operate ON THE BOARD over SSH, not on the host PC. Treat every path as a board path (absolute, or relative to the SSH user home).',
    'exec is stateless between calls (cd does not persist; use absolute paths). apply_patch and exec_background are suspended; use edit_file/write_file and `nohup ... &` instead.',
    'Host-local files are unreachable until the user runs /disconnect.',
    'Robotics first: for ROS2 graph work call `load_skill` (rdk / ros skills if listed) or `skillhub_search` query="ros2" then `skillhub_install` + `load_skill`. Prefer ros2_* / device_* tools over ad-hoc shell when they exist. After mutations, verify with real probes (topic list/hz, node list, process list) — never claim Connected/Launched without evidence.',
  ].join('\n');
}

function restoreDeviceSession(
  agent: MossAgent,
  handle: CliDeviceSessionHandle
): { removed: number; restored: number } {
  let removed = 0;
  for (const name of handle.registeredNames) {
    if (agent.tools.get(name)) {
      agent.tools.remove(name);
      removed += 1;
    }
  }
  let restored = 0;
  for (const tool of handle.displaced) {
    agent.tools.register(tool);
    restored += 1;
  }
  if (handle.promptLayer && agent.config?.extraPromptLayers) {
    const idx = agent.config.extraPromptLayers.indexOf(handle.promptLayer);
    if (idx >= 0) agent.config.extraPromptLayers.splice(idx, 1);
  }
  return { removed, restored };
}

export async function connectDeviceForSession(
  agent: MossAgent,
  runtime: CliRuntimeStatus | undefined,
  config: DeviceSshConfig,
  options: ConnectDeviceOptions = {}
): Promise<DeviceConnectResult> {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  const mode = options.mode ?? 'board';
  let verifiedHostname: string | undefined;
  const sshSession = new DeviceSshSession(config);

  if (options.skipVerify) {
    try {
      await sshSession.connect();
    } catch {
      const result = await probeDeviceSsh(config, { executor: sshSession });
      await sshSession.close();
      const failure = buildConnectFailureMessage(config, result, options.locale, {
        skippedPreflight: true,
      });
      return { ok: false, message: failure.message, retryInput: failure.retryInput };
    }
  } else {
    const probe = options.probe ?? probeDeviceSsh;
    const result = options.probe
      ? await probe(config)
      : await probeDeviceSsh(config, { executor: sshSession });
    if (!result.ok) {
      await sshSession.close();
      const failure = buildConnectFailureMessage(config, result, options.locale);
      return { ok: false, message: failure.message, retryInput: failure.retryInput };
    }
    verifiedHostname = result.detail;
    if (options.probe) {
      try {
        await sshSession.connect();
      } catch {
        const transport = await probeDeviceSsh(config, { executor: sshSession });
        await sshSession.close();
        const failure = buildConnectFailureMessage(config, transport, options.locale);
        return { ok: false, message: failure.message, retryInput: failure.retryInput };
      }
    }
  }

  if (runtime?.deviceSession) {
    await runtime.deviceSession.sshSession?.close();
    restoreDeviceSession(agent, runtime.deviceSession);
    runtime.deviceSession = null;
  }

  // Win32 bypasses ControlMaster, so each liveness probe is a standalone ssh
  // (TCP + askpass handshake). 3s is too tight for that; a single transient
  // probe failure must also not sever the session — retry once before giving up.
  const isWindows = (config.platformOverride ?? process.platform) === 'win32';
  const health = new DeviceConnectionHealth(config, {
    probe: options.probe
      ? async (probeConfig) => options.probe!(probeConfig)
      : (probeConfig, probeOptions) =>
          probeDeviceSsh(probeConfig, {
            timeoutMs: isWindows ? 15_000 : 3_000,
            abortSignal: probeOptions?.abortSignal,
            executor: sshSession,
          }),
    probeRetries: isWindows ? 1 : 0,
    onDisconnected: (snapshot) => {
      if (!runtime?.device || runtime.device.host !== config.host) return;
      runtime.device.connectionState = 'disconnected';
      runtime.device.connectionReason = snapshot.reason;
    },
  });

  const sessionTools = [
    ...createDeviceSshTools(config, health, sshSession),
    ...createDeviceDiagnosticsTools(config, health, sshSession),
    ...createRos1Tools(config, health, sshSession),
    ...createRos2Tools(config, health, sshSession),
    ...(mode === 'board'
      ? createBoardWorkspaceTools(config, { sshExecutor: sshSession }, health)
      : []),
  ];

  const displaced: CliDeviceSessionHandle['displaced'] = [];
  if (mode === 'board') {
    for (const name of [...BOARD_REPLACED_TOOL_NAMES, ...BOARD_SUSPENDED_TOOL_NAMES]) {
      const existing = agent.tools.get(name);
      if (existing) displaced.push(existing);
    }
    for (const name of BOARD_SUSPENDED_TOOL_NAMES) {
      agent.tools.remove(name);
    }
  }

  for (const tool of sessionTools) {
    agent.tools.remove(tool.name);
    agent.tools.register(tool);
  }

  let promptLayer: string | undefined;
  if (mode === 'board' && agent.config) {
    promptLayer = buildBoardModePromptLayer(target, verifiedHostname);
    if (!agent.config.extraPromptLayers) agent.config.extraPromptLayers = [];
    agent.config.extraPromptLayers.push(promptLayer);
  }

  const environmentIdentity = await probeDeviceEnvironmentFacts(sshSession);
  if (runtime) {
    runtime.device = {
      host: config.host,
      user: config.user,
      port: config.port,
      connectionState: 'connected',
    };
    runtime.deviceSession = {
      registeredNames: sessionTools.map((tool) => tool.name),
      displaced,
      promptLayer,
      boardMode: mode === 'board',
      sshSession,
      environmentIdentity,
    };
  }

  const zh = isZh(options.locale);
  const headline = options.skipVerify
    ? `[device] Persistent SSH session established to ${target} (hostname probe skipped).`
    : `[device] Persistent SSH session established to ${target} (remote hostname: ${verifiedHostname}).`;
  const modeLine =
    mode === 'board'
      ? zh
        ? '板卡模式：exec 和文件工具现在通过持久 SSH 会话直接在板卡上执行（apply_patch/exec_background 已挂起）。ROS1/ROS2 与 USB/MIPI 相机会按板端实际环境发现。退出：/disconnect 或空输入按 Ctrl+D；想保留本地工具用 /connect --hybrid。'
        : 'BOARD MODE: exec and file tools now run through one persistent SSH session on the board (apply_patch/exec_background suspended). ROS1/ROS2 and USB/MIPI cameras are discovered from the board environment. Exit with /disconnect or Ctrl+D on an empty prompt; use /connect --hybrid to keep local tools instead.'
      : zh
        ? '混合模式：本地工具保留，已追加 device_*/ros1_*/ros2_* 工具，并共用持久 SSH 会话。/disconnect 可移除。'
        : 'Hybrid mode: local tools kept; device_*/ros1_*/ros2_* tools share one persistent SSH session. /disconnect removes them.';
  const skillLine = zh
    ? '机器人技能：需要 ROS2/板端工作流时先 load_skill；本地没有可 skillhub_search "ros2" → skillhub_install → load_skill。成功结论必须来自真实探测（topic/node/进程），不要空口报 Connected/Launched。'
    : 'Robotics skills: call load_skill for RDK/ROS workflows; if missing, skillhub_search "ros2" → skillhub_install → load_skill. Success claims must come from real probes (topics/nodes/processes), never fixed "Connected/Launched" strings.';
  return {
    ok: true,
    message: [headline, modeLine, skillLine].join('\n'),
  };
}

export async function disconnectDeviceForSession(
  agent: MossAgent,
  runtime: CliRuntimeStatus | undefined
): Promise<string> {
  const handle = runtime?.deviceSession;
  const device = runtime?.device;
  if (!handle) {
    if (device && runtime) {
      runtime.device = null;
      return `[device] Cleared device state for ${device.user || 'root'}@${device.host} (no session tools were registered).`;
    }
    return '[device] No board is connected. Use /connect <[user@]ip> first.';
  }

  await handle.sshSession?.close();
  const { removed, restored } = restoreDeviceSession(agent, handle);
  const target = device
    ? `${device.user || 'root'}@${device.host}:${device.port || 22}`
    : 'the board';
  if (runtime) {
    runtime.device = null;
    runtime.deviceSession = null;
  }
  const localExecBack = handle.boardMode ? Boolean(agent.tools.get('exec')) : true;
  if (handle.boardMode && !localExecBack) {
    return `[device] Disconnected from ${target}, but restoring local tools FAILED (exec missing). Restart moss to recover a clean local toolset.`;
  }
  return [
    `[device] Disconnected from ${target}. Removed ${removed} board/device tools${restored ? `, restored ${restored} local tools` : ''}.`,
    handle.boardMode
      ? 'Back on the host PC: exec and file tools operate locally again.'
      : 'Local toolset unchanged.',
  ].join('\n');
}
