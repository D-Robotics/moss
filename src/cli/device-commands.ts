/**
 * `moss device <subcommand>` — the device-registry surface (robotics closed
 * loop P0 onboarding). Writes `.moss/devices.json` in the same DeviceTarget
 * contract the resolver reads; auth entries keep env-var references, never
 * secret values.
 */
import { isZhLocale } from './cli-locale.js';
import type { DeviceAuthConfig, DeviceTarget } from '../contracts/device.js';
import {
  loadDeviceRegistry,
  saveDeviceRegistry,
  registryIsCredentialSafe,
} from '../device/device-registry-file.js';

const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function renderDeviceUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss device add <id> <host> [--port N] [--user U] [--kind rdk|linux]',
      '              [--password-env VAR] [--key PATH]  注册一台设备',
      '  moss device list                             查看已注册设备',
      '  moss device remove <id>                      删除一台设备',
      '  moss device test [id]                        立即连接并读取设备信息',
      '  moss device fleet <probe> --devices id1,id2  只读并行观测一组已注册设备',
      '',
      '  fleet probe：info | processes | resources | temperature | robotics |',
      '               network | cameras | file_read <path> | file_list <path>',
      '              （也可写 device_info 等全名）',
      '  fleet 退出码：0 = 全部成功；1 = 有设备失败（partial/all-fail 见输出）',
      '',
      '凭据只存环境变量引用（如 --password-env MOSS_DEVICE_PASSWORD）；',
      '实际值放在 .env 或环境变量里，绝不写入 devices.json。',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss device add <id> <host> [--port N] [--user U] [--kind rdk|linux]',
    '              [--password-env VAR] [--key PATH]  register a device',
    '  moss device list                             show registered devices',
    '  moss device remove <id>                      drop a device',
    '  moss device test [id]                        connect + read identity now',
    '  moss device fleet <probe> --devices id1,id2  read-only parallel probe of a device set',
    '',
    '  fleet probes: info | processes | resources | temperature | robotics |',
    '                network | cameras | file_read <path> | file_list <path>',
    '                (full names like device_info also work)',
    '  fleet exit code: 0 = all passed; 1 = some device failed (see partial/all-fail)',
    '',
    'Credentials are env-var references (e.g. --password-env MOSS_DEVICE_PASSWORD);',
    'values live in .env or the environment — never in devices.json.',
  ].join('\n');
}

/**
 * Read-only fleet probes exposed on the CLI. Each returns a formatted string so
 * `moss device fleet <probe>` prints one uniform block per device. Names are
 * the short probe names; a leading `device_` is stripped before lookup so the
 * tool names (`device_info`, …) also work.
 */
interface FleetCliProbe {
  /** One-line summary printed in errors/usage. */
  summary: string;
  /** True when the probe needs a remote path argument. */
  needsPath: boolean;
  run: (
    conn: import('../contracts/device.js').DeviceConnection,
    target: DeviceTarget,
    signal: AbortSignal | undefined,
    pathArg: string | undefined
  ) => Promise<string>;
}

function fleetProbes(): Record<string, FleetCliProbe> {
  return {
    info: {
      summary: 'identity: os / cpu / memory / uptime',
      needsPath: false,
      async run(conn, target, signal) {
        const { INFO_PROBE_SCRIPT, parseInfoProbe, formatInfoSnapshot } =
          await import('../device/observation.js');
        const { formatDeviceTarget } = await import('../device/device-target.js');
        const res = await conn.exec(INFO_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatInfoSnapshot(parseInfoProbe(res.stdout, target), formatDeviceTarget(target));
      },
    },
    processes: {
      summary: 'top processes by cpu',
      needsPath: false,
      async run(conn, target, signal) {
        const { PROCESSES_PROBE_SCRIPT, parseProcessesProbe, formatProcessList } =
          await import('../device/observation.js');
        const { formatDeviceTarget } = await import('../device/device-target.js');
        const res = await conn.exec(PROCESSES_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatProcessList(
          parseProcessesProbe(res.stdout, target.deviceId),
          formatDeviceTarget(target)
        );
      },
    },
    resources: {
      summary: 'memory / load / disk usage',
      needsPath: false,
      async run(conn, target, signal) {
        const { RESOURCES_PROBE_SCRIPT, parseResourcesProbe, formatResourceSnapshot } =
          await import('../device/observation.js');
        const { formatDeviceTarget } = await import('../device/device-target.js');
        const res = await conn.exec(RESOURCES_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatResourceSnapshot(
          parseResourcesProbe(res.stdout, target.deviceId),
          formatDeviceTarget(target)
        );
      },
    },
    temperature: {
      summary: 'thermal zones',
      needsPath: false,
      async run(conn, target, signal) {
        const { TEMPERATURE_PROBE_SCRIPT, parseTemperatureProbe, formatTemperatureSnapshot } =
          await import('../device/observation.js');
        const res = await conn.exec(TEMPERATURE_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatTemperatureSnapshot(parseTemperatureProbe(res.stdout, target.deviceId));
      },
    },
    robotics: {
      summary: 'ROS/TROS installation status',
      needsPath: false,
      async run(conn, target, signal) {
        const { ROBOTICS_PROBE_SCRIPT, parseRoboticsProbe, formatRoboticsSnapshot } =
          await import('../device/observation.js');
        const { formatDeviceTarget } = await import('../device/device-target.js');
        const res = await conn.exec(ROBOTICS_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatRoboticsSnapshot(
          parseRoboticsProbe(res.stdout, target.deviceId),
          formatDeviceTarget(target)
        );
      },
    },
    network: {
      summary: 'global addresses, links, default route',
      needsPath: false,
      async run(conn, target, signal) {
        const { NETWORK_PROBE_SCRIPT, parseNetworkProbe, formatNetworkSnapshot } =
          await import('../device/observation.js');
        const { formatDeviceTarget } = await import('../device/device-target.js');
        const res = await conn.exec(NETWORK_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatNetworkSnapshot(
          parseNetworkProbe(res.stdout, target.deviceId),
          formatDeviceTarget(target)
        );
      },
    },
    cameras: {
      summary: 'v4l2 camera devices',
      needsPath: false,
      async run(conn, target, signal) {
        const { CAMERAS_PROBE_SCRIPT, parseCamerasProbe, formatCamerasSnapshot } =
          await import('../device/observation.js');
        const { formatDeviceTarget } = await import('../device/device-target.js');
        const res = await conn.exec(CAMERAS_PROBE_SCRIPT, {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        });
        return formatCamerasSnapshot(
          parseCamerasProbe(res.stdout, target.deviceId),
          formatDeviceTarget(target)
        );
      },
    },
    file_read: {
      summary: 'read a remote file (needs <path>)',
      needsPath: true,
      async run(conn, target, signal, pathArg) {
        if (!pathArg) throw new Error('file_read needs a remote <path>');
        const content = await conn.readFile(pathArg, {
          maxBytes: 64 * 1024,
          ...(signal ? { signal } : {}),
        });
        return `file ${pathArg} on ${target.deviceId}:\n${content}`;
      },
    },
    file_list: {
      summary: 'list a remote directory (needs <path>)',
      needsPath: true,
      async run(conn, target, signal, pathArg) {
        if (!pathArg) throw new Error('file_list needs a remote <path>');
        if (signal?.aborted) throw new Error('aborted');
        const entries = await conn.listDir(pathArg);
        const rows = entries
          .slice(0, 200)
          .map(
            (entry) =>
              `  ${entry.type === 'dir' ? 'd' : entry.type === 'symlink' ? 'l' : '-'} ${entry.name}` +
              (entry.sizeBytes !== undefined ? ` (${entry.sizeBytes}B)` : '')
          );
        return `dir ${pathArg} on ${target.deviceId}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n${rows.join('\n')}`;
      },
    },
  };
}

/** Normalize a CLI probe token to a probe-table key (`device_info` → `info`). */
function normalizeProbeName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith('device_') ? lower.slice('device_'.length) : lower;
}

/** Render the per-device + aggregate report for a fleet run. */
function formatFleetReport(
  probeLabel: string,
  result: import('../contracts/device.js').FleetResult<string>,
  zh: boolean
): string {
  const lines: string[] = [
    zh
      ? `fleet ${probeLabel} · ${result.results.length} 台设备`
      : `fleet ${probeLabel} · ${result.results.length} device(s)`,
  ];
  for (const entry of result.results) {
    const mark = entry.status === 'pass' ? '✓' : '✗';
    lines.push(`${mark} ${entry.deviceId.padEnd(16)} ${entry.endpoint}`);
    if (entry.status === 'pass' && entry.result !== undefined) {
      for (const line of entry.result.split('\n')) lines.push(`    ${line}`);
    } else if (entry.status === 'fail') {
      lines.push(`    ${zh ? '失败' : 'failed'}: ${entry.error ?? 'unknown error'}`);
    }
  }
  const passCount = result.results.filter((r) => r.status === 'pass').length;
  lines.push(
    '',
    zh
      ? `结果：${result.outcome}（${passCount}/${result.results.length} 通过）`
      : `outcome: ${result.outcome} (${passCount}/${result.results.length} passed)`
  );
  return lines.join('\n');
}

export interface DeviceCommandContext {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}

/** Parse device-add argv into a DeviceTarget, or the first problem. */
export function buildTargetFromArgv(
  id: string,
  argv: readonly string[]
): DeviceTarget | { error: string } {
  if (!DEVICE_NAME_RE.test(id)) return { error: `id "${id}" must be alphanumeric/-/_/.` };
  let host: string | undefined;
  let port: number | undefined;
  let user: string | undefined;
  let kind: 'rdk' | 'linux' = 'linux';
  let passwordEnvVar: string | undefined;
  let privateKeyPath: string | undefined;
  let passphraseEnvVar: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? '';
    const next = argv[i + 1];
    if (token === '--port') {
      const parsed = Number(next);
      if (next === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        return { error: '--port expects a positive integer' };
      }
      port = parsed;
      i += 2;
      continue;
    }
    if (token === '--user') {
      if (next === undefined) return { error: '--user expects a name' };
      user = next;
      i += 2;
      continue;
    }
    if (token === '--kind') {
      if (next !== 'rdk' && next !== 'linux') return { error: '--kind expects rdk|linux' };
      kind = next;
      i += 2;
      continue;
    }
    if (token === '--password-env') {
      if (next === undefined) return { error: '--password-env expects an env var NAME' };
      passwordEnvVar = next;
      i += 2;
      continue;
    }
    if (token === '--key') {
      if (next === undefined) return { error: '--key expects a key file path' };
      privateKeyPath = next;
      i += 2;
      continue;
    }
    if (token === '--passphrase-env') {
      if (next === undefined) return { error: '--passphrase-env expects an env var NAME' };
      passphraseEnvVar = next;
      i += 2;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) return { error: `unknown option "${token}"` };
    if (host === undefined) {
      host = token;
      i += 1;
      continue;
    }
    return { error: `unexpected extra argument "${token}"` };
  }
  if (host === undefined) return { error: 'a host is required' };
  const auth: DeviceAuthConfig | undefined = privateKeyPath
    ? {
        method: 'private-key',
        privateKeyPath,
        ...(passphraseEnvVar ? { passphraseEnvVar } : {}),
      }
    : passwordEnvVar
      ? { method: 'password', passwordEnvVar }
      : undefined;
  return {
    deviceId: id,
    kind,
    host,
    ...(port !== undefined ? { port } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(auth ? { auth } : {}),
  };
}

export async function runDeviceCommand(argv: string[], ctx: DeviceCommandContext): Promise<number> {
  const out = (text: string) => process.stdout.write(`${text}\n`);
  const err = (text: string) => process.stderr.write(`${text}\n`);
  const sub = argv[0] ?? 'list';
  const zh = isZhLocale();

  if (sub === 'add') {
    const id = argv[1];
    if (!id) {
      err('moss device add: a device id is required.\n\n' + renderDeviceUsage(zh));
      return 2;
    }
    const built = buildTargetFromArgv(id, argv.slice(2));
    if ('error' in built) {
      err(`moss device add: ${built.error}`);
      return 2;
    }
    if (!registryIsCredentialSafe([built])) {
      err(
        zh
          ? 'moss device add: 认证必须引用环境变量，不能内嵌密钥。'
          : 'moss device add: auth must reference env vars, not embed secrets.'
      );
      return 2;
    }
    const registry = loadDeviceRegistry(ctx.workspaceDir);
    if (registry.some((device) => device.deviceId === id)) {
      err(
        zh
          ? `moss device add: "${id}" 已存在（先 moss device remove ${id}）`
          : `moss device add: "${id}" already exists (moss device remove ${id} first)`
      );
      return 1;
    }
    registry.push(built);
    saveDeviceRegistry(ctx.workspaceDir, registry);
    out(
      zh
        ? `已添加 ${id} → ${built.user ?? 'root'}@${built.host}:${built.port ?? 22} (${built.kind})`
        : `Added ${id} → ${built.user ?? 'root'}@${built.host}:${built.port ?? 22} (${built.kind})`
    );
    out(zh ? `现在验证：moss device test ${id}` : `Test it now: moss device test ${id}`);
    return 0;
  }

  if (sub === 'list') {
    const registry = loadDeviceRegistry(ctx.workspaceDir);
    const envHost = (ctx.env ?? process.env).MOSS_DEVICE_HOST?.trim();
    if (envHost)
      out(
        zh
          ? `  (env)              MOSS_DEVICE_HOST=${envHost} — 环境变量优先于注册表`
          : `  (env)              MOSS_DEVICE_HOST=${envHost} — env overrides the registry`
      );
    if (registry.length === 0) {
      out(
        zh
          ? '尚无已注册设备。添加一台：moss device add <id> <host>'
          : 'No devices registered. Add one: moss device add <id> <host>'
      );
      return 0;
    }
    for (const device of registry) {
      const auth =
        device.auth?.method === 'private-key'
          ? `key:${device.auth.privateKeyPath}`
          : device.auth?.passwordEnvVar
            ? `env:${device.auth.passwordEnvVar}`
            : 'no-auth';
      out(
        `  ${device.deviceId.padEnd(16)} ${device.user ?? 'root'}@${device.host}:${device.port ?? 22}  ${device.kind}  ${auth}`
      );
    }
    out(
      zh
        ? `\n共 ${registry.length} 台设备。moss device test <id> 可立即检测。`
        : `\n${registry.length} device(s). moss device test <id> checks one now.`
    );
    return 0;
  }

  if (sub === 'remove') {
    const id = argv[1];
    if (!id) {
      err('moss device remove: a device id is required.');
      return 2;
    }
    const registry = loadDeviceRegistry(ctx.workspaceDir);
    const next = registry.filter((device) => device.deviceId !== id);
    if (next.length === registry.length) {
      err(
        zh ? `moss device remove: "${id}" 未注册` : `moss device remove: "${id}" is not registered`
      );
      return 1;
    }
    saveDeviceRegistry(ctx.workspaceDir, next);
    out(zh ? `已删除 ${id}` : `Removed ${id}`);
    return 0;
  }

  if (sub === 'test') {
    const id = argv[1];
    const { resolveDefaultDeviceTarget, formatDeviceTarget } =
      await import('../device/device-target.js');
    const target =
      id !== undefined
        ? loadDeviceRegistry(ctx.workspaceDir).find((device) => device.deviceId === id)
        : resolveDefaultDeviceTarget({ workspaceDir: ctx.workspaceDir });
    if (!target) {
      err(
        zh
          ? `moss device test: "${id ?? 'default'}" 未配置（查看 moss device list）`
          : `moss device test: "${id ?? 'default'}" is not configured (moss device list)`
      );
      return 1;
    }
    out(
      zh
        ? `正在连接 ${formatDeviceTarget(target)}（${target.kind}）…`
        : `Connecting to ${formatDeviceTarget(target)} (${target.kind})…`
    );
    const { getDeviceConnection } = await import('../device/device-registry.js');
    const { INFO_PROBE_SCRIPT } = await import('../device/observation.js');
    try {
      const conn = await getDeviceConnection(target);
      const probe = await conn.exec(INFO_PROBE_SCRIPT, { timeoutMs: 15_000 });
      const first = probe.stdout.trim().split('\n').slice(0, 5).join('\n    ');
      out(
        zh
          ? `  已连接 — 探测${probe.exitCode === 0 ? '成功' : `退出码 ${probe.exitCode}`}`
          : `  connected — probe ${probe.exitCode === 0 ? 'ok' : `exit ${probe.exitCode}`}`
      );
      out(`    ${first || (zh ? '(探测无输出)' : '(probe returned no output)')}`);
      return 0;
    } catch (failure) {
      err(
        zh
          ? `  失败：${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`
          : `  failed: ${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`
      );
      err(
        zh
          ? '  请检查 host/port/user 与凭据（--password-env / --key），以及 sshd 是否在运行。'
          : '  check host/port/user and credentials (--password-env / --key), and that sshd runs.'
      );
      return 1;
    }
  }

  if (sub === 'fleet') {
    const probes = fleetProbes();
    const probeArg = argv[1];
    if (!probeArg) {
      err(
        zh
          ? 'moss device fleet: 需要一个 probe 名（info/processes/…）。\n\n'
          : 'moss device fleet: a probe name is required (info/processes/…).\n\n'
      );
      err(renderDeviceUsage(zh));
      return 2;
    }
    const probeKey = normalizeProbeName(probeArg);
    const probeDef = probes[probeKey];
    if (!probeDef) {
      err(
        zh
          ? `moss device fleet: 未知 probe "${probeArg}"（可选：${Object.keys(probes).join(', ')}）`
          : `moss device fleet: unknown probe "${probeArg}" (choose from: ${Object.keys(probes).join(', ')})`
      );
      return 2;
    }

    const deviceIds: string[] = [];
    let concurrency: number | undefined;
    let pathArg: string | undefined;
    let i = 2;
    while (i < argv.length) {
      const token = argv[i] ?? '';
      if (token === '--devices' || token.startsWith('--devices=')) {
        const value = token === '--devices' ? argv[i + 1] : token.slice('--devices='.length);
        if (value === undefined || value.length === 0) {
          err(
            zh
              ? 'moss device fleet: --devices 需要一个 id 列表'
              : 'moss device fleet: --devices needs an id list'
          );
          return 2;
        }
        for (const raw of value.split(',')) {
          const id = raw.trim();
          if (id.length > 0) deviceIds.push(id);
        }
        i += token === '--devices' ? 2 : 1;
        continue;
      }
      if (token === '--concurrency' || token.startsWith('--concurrency=')) {
        const value =
          token === '--concurrency' ? argv[i + 1] : token.slice('--concurrency='.length);
        const parsed = Number(value);
        if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
          err(
            zh
              ? 'moss device fleet: --concurrency 需要正整数'
              : 'moss device fleet: --concurrency expects a positive integer'
          );
          return 2;
        }
        concurrency = parsed;
        i += token === '--concurrency' ? 2 : 1;
        continue;
      }
      if (!token.startsWith('-')) {
        if (pathArg === undefined && probeDef.needsPath) {
          pathArg = token;
          i += 1;
          continue;
        }
        err(
          zh
            ? `moss device fleet: 多余参数 "${token}"`
            : `moss device fleet: unexpected argument "${token}"`
        );
        return 2;
      }
      err(
        zh
          ? `moss device fleet: 未知选项 "${token}"`
          : `moss device fleet: unknown option "${token}"`
      );
      return 2;
    }

    if (probeDef.needsPath && pathArg === undefined) {
      err(
        zh
          ? `moss device fleet: ${probeKey} 需要远端 <path>`
          : `moss device fleet: ${probeKey} needs a remote <path>`
      );
      return 2;
    }
    if (deviceIds.length === 0) {
      err(
        zh
          ? 'moss device fleet: --devices 必填，且不能为空（不隐式 fan-out 全表）'
          : 'moss device fleet: --devices is required and must not be empty (no implicit full-registry fan-out)'
      );
      return 2;
    }

    const { resolveDeviceTargets } = await import('../device/device-target.js');
    const selection = resolveDeviceTargets(deviceIds, { workspaceDir: ctx.workspaceDir });
    if (selection.missing.length > 0) {
      err(
        zh
          ? `moss device fleet: 未注册的设备 id：${selection.missing.join(', ')}（查看 moss device list）`
          : `moss device fleet: unregistered device id(s): ${selection.missing.join(', ')} (see moss device list)`
      );
      return 1;
    }

    const { runFleetReadonly } = await import('../device/fleet-readonly.js');
    const result = await runFleetReadonly(
      selection.targets,
      (conn, target, signal) => probeDef.run(conn, target, signal, pathArg),
      concurrency !== undefined ? { concurrency } : {}
    );
    out(formatFleetReport(probeKey, result, zh));
    return result.outcome === 'all-pass' ? 0 : 1;
  }

  err(renderDeviceUsage(zh));
  return 2;
}
