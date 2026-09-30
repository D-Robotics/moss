import type {
  DeviceInfoSnapshot,
  DeviceKind,
  DeviceProcessListSnapshot,
  DeviceProcessSnapshot,
  DeviceResourceSnapshot,
  DeviceDiskUsage,
  DeviceTemperatureSnapshot,
  DeviceThermalZone,
} from '../contracts/device.js';

/**
 * Device runtime observation: POSIX-sh probes + parsers. Builders and parsers
 * are pure so they unit-test without a device; each probe runs as one shell
 * script over the exec channel and tolerates partial failures (missing
 * /proc entries, busybox ps) by reporting what it found.
 */

export const INFO_PROBE_SCRIPT = [
  'printf "S|%s|%s|%s|%s\\n" "$(uname -s 2>/dev/null)" "$(uname -n 2>/dev/null)" "$(uname -r 2>/dev/null)" "$(uname -m 2>/dev/null)"',
  'awk -F": " \'/^model name/{print "CPU|"$2; exit}\' /proc/cpuinfo 2>/dev/null',
  'awk -F": " \'/^Hardware/{print "HW|"$2; exit}\' /proc/cpuinfo 2>/dev/null',
  'if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; printf "OS|%s\\n" "$PRETTY_NAME"; fi',
  'printf "CORES|%s\\n" "$(nproc 2>/dev/null)"',
  'awk \'/^MemTotal/{print "MEMTOTAL|"$2} /^MemAvailable/{print "MEMAVAIL|"$2}\' /proc/meminfo 2>/dev/null',
  'read -r UP _ < /proc/uptime 2>/dev/null && printf "UPTIME|%s\\n" "$UP"',
  'printf "LOADAVG|%s\\n" "$(cat /proc/loadavg 2>/dev/null)"',
].join('\n');

export const PROCESSES_PROBE_SCRIPT =
  'ps -eo pid=,user:20=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n 40';

export const RESOURCES_PROBE_SCRIPT = [
  'awk \'/^MemTotal/{print "MEMTOTAL|"$2} /^MemAvailable/{print "MEMAVAIL|"$2}\' /proc/meminfo 2>/dev/null',
  'printf "LOADAVG|%s\\n" "$(cat /proc/loadavg 2>/dev/null)"',
  'df -P -k 2>/dev/null | tail -n +2',
].join('\n');

export const TEMPERATURE_PROBE_SCRIPT =
  'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; printf "ZONE|%s|%s|%s\\n" "${z##*/}" "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done';

/**
 * Robotics stack probe: which ROS/TROS installation exists on the device.
 * TROS (D-Robotics) installs to /opt/tros; upstream ROS2 to /opt/ros/<distro>.
 * Everything is optional — a plain Linux host reports "no ROS" gracefully.
 */ export const ROBOTICS_PROBE_SCRIPT = [
  'if [ -d /opt/tros ]; then printf "ROSDIR|/opt/tros|tros\\n"; fi',
  'for d in /opt/ros/*; do [ -d "$d" ] && printf "ROSDIR|%s|%s\\n" "$d" "${d##*/}"; done',
  'for b in /opt/tros/bin/ros2 /opt/ros/*/bin/ros2; do [ -x "$b" ] && printf "ROS2BIN|%s\\n" "$b"; done',
  'for f in /opt/tros/version /opt/tros/version.txt /opt/tros/RELEASE; do [ -r "$f" ] && printf "TROSVER|%s|%s\\n" "$f" "$(head -c 120 "$f" | tr -d "\\n")"; done',
  'if [ -x /usr/bin/hbm_shell ] || [ -x /usr/local/bin/hbm_shell ]; then printf "HBM|present\\n"; fi',
].join('\n');

export interface RoboticsStackSnapshot {
  deviceId: string;
  collectedAt: number;
  /** Installed distro dirs: ['/opt/tros' (tros), '/opt/ros/humble' (humble)]. */
  installations: Array<{ path: string; distro: string }>;
  ros2Binaries: string[];
  trosVersion?: string;
  hbmPresent?: boolean;
}

export function parseRoboticsProbe(stdout: string, deviceId: string): RoboticsStackSnapshot {
  const snapshot: RoboticsStackSnapshot = {
    deviceId,
    collectedAt: Date.now(),
    installations: [],
    ros2Binaries: [],
  };
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes('|')) continue;
    const sep = line.indexOf('|');
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    switch (key) {
      case 'ROSDIR': {
        const [p, distro] = value.split('|');
        if (p) {
          const fallback = p.split('/').filter(Boolean).pop() ?? p;
          snapshot.installations.push({ path: p, distro: distro ?? fallback });
        }
        break;
      }
      case 'ROS2BIN':
        if (value) snapshot.ros2Binaries.push(value);
        break;
      case 'TROSVER': {
        const [, version] = value.split('|');
        if (version) snapshot.trosVersion = version;
        break;
      }
      case 'HBM':
        snapshot.hbmPresent = true;
        break;
    }
  }
  return snapshot;
}

export function formatRoboticsSnapshot(snapshot: RoboticsStackSnapshot, endpoint: string): string {
  if (snapshot.installations.length === 0) {
    return (
      `robotics stack on ${snapshot.deviceId} (${endpoint}): none detected.\n` +
      `No /opt/tros or /opt/ros installation found — this device is a plain Linux host for robotics purposes. ` +
      `(ros2_* tools will not work until a ROS/TROS runtime is installed.)`
    );
  }
  const lines = [`robotics stack on ${snapshot.deviceId} (${endpoint}):`];
  for (const install of snapshot.installations) {
    lines.push(`  ${install.path} (distro: ${install.distro})`);
  }
  if (snapshot.trosVersion) lines.push(`  TROS version: ${snapshot.trosVersion}`);
  if (snapshot.hbmPresent) lines.push('  hbm: present');
  for (const bin of snapshot.ros2Binaries) lines.push(`  ros2: ${bin}`);
  if (snapshot.ros2Binaries.length > 0) {
    lines.push(
      'ROS commands run via device_exec after sourcing the setup, e.g.: source /opt/tros/setup.bash && ros2 node list'
    );
  } else {
    lines.push('No ros2 binary found in the installation — runtime may be broken or partial.');
  }
  return lines.join('\n');
}

function parseLoadavg(line: string): [number, number, number] | undefined {
  const parts = line.trim().split(/\s+/).slice(0, 3).map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return parts as [number, number, number];
  }
  return undefined;
}

function kbToBytes(kb: number): number {
  return kb * 1024;
}

export function parseInfoProbe(
  stdout: string,
  target: { deviceId: string; kind: DeviceKind }
): DeviceInfoSnapshot {
  const snapshot: DeviceInfoSnapshot = {
    deviceId: target.deviceId,
    kind: target.kind,
    connectedAt: Date.now(),
  };
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.includes('|')) continue;
    const sep = line.indexOf('|');
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    switch (key) {
      case 'S': {
        const [sysname, hostname, kernel, arch] = value.split('|');
        if (sysname) snapshot.sysname = sysname;
        if (hostname) snapshot.hostname = hostname;
        if (kernel) snapshot.kernel = kernel;
        if (arch) snapshot.arch = arch;
        break;
      }
      case 'CPU':
        if (value) snapshot.cpuModel = value.trim();
        break;
      case 'HW':
        if (value) snapshot.hardware = value.trim();
        break;
      case 'OS':
        if (value) snapshot.osPrettyName = value.trim();
        break;
      case 'CORES': {
        const cores = Number(value);
        if (Number.isFinite(cores) && cores > 0) snapshot.cpuCores = cores;
        break;
      }
      case 'MEMTOTAL': {
        const kb = Number(value);
        if (Number.isFinite(kb) && kb > 0) snapshot.memTotalBytes = kbToBytes(kb);
        break;
      }
      case 'MEMAVAIL': {
        const kb = Number(value);
        if (Number.isFinite(kb) && kb > 0) snapshot.memAvailableBytes = kbToBytes(kb);
        break;
      }
      case 'UPTIME': {
        const up = Number(value);
        if (Number.isFinite(up) && up > 0) snapshot.uptimeSeconds = Math.round(up);
        break;
      }
      case 'LOADAVG':
        snapshot.loadavg = parseLoadavg(value);
        break;
    }
  }
  return snapshot;
}

export function parseProcessesProbe(stdout: string, deviceId: string): DeviceProcessListSnapshot {
  const processes: DeviceProcessSnapshot[] = [];
  let psUnsupported = stdout.trim() === '';
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      user: match[2],
      cpuPercent: Number(match[3]),
      memPercent: Number(match[4]),
      rssKb: Number(match[5]),
      command: match[6].trim(),
    });
  }
  if (processes.length === 0) psUnsupported = true;
  return {
    deviceId,
    collectedAt: Date.now(),
    processes,
    ...(psUnsupported ? { psUnsupported } : {}),
  };
}

export function parseResourcesProbe(stdout: string, deviceId: string): DeviceResourceSnapshot {
  const snapshot: DeviceResourceSnapshot = {
    deviceId,
    collectedAt: Date.now(),
    disks: [],
  };
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes('|')) {
      const sep = line.indexOf('|');
      const key = line.slice(0, sep);
      const value = line.slice(sep + 1);
      if (key === 'MEMTOTAL') {
        const kb = Number(value);
        if (Number.isFinite(kb) && kb > 0) snapshot.memTotalBytes = kbToBytes(kb);
      } else if (key === 'MEMAVAIL') {
        const kb = Number(value);
        if (Number.isFinite(kb) && kb > 0) snapshot.memAvailableBytes = kbToBytes(kb);
      } else if (key === 'LOADAVG') {
        snapshot.loadavg = parseLoadavg(value);
      }
      continue;
    }
    // POSIX df -P -k: filesystem 1024-blocks used available capacity mounted-on
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);
    if (!match) continue;
    const disk: DeviceDiskUsage = {
      filesystem: match[1],
      mount: match[6],
      totalBytes: kbToBytes(Number(match[2])),
      availableBytes: kbToBytes(Number(match[4])),
      usedPercent: Number(match[5]),
    };
    snapshot.disks.push(disk);
  }
  return snapshot;
}

export function parseTemperatureProbe(stdout: string, deviceId: string): DeviceTemperatureSnapshot {
  const zones: DeviceThermalZone[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('ZONE|')) continue;
    const [, zone, label, milli] = line.split('|');
    const milliC = Number(milli);
    if (!Number.isFinite(milliC)) continue;
    zones.push({
      zone: zone ?? '',
      ...(label ? { label } : {}),
      celsius: Math.round((milliC / 1000) * 10) / 10,
    });
  }
  return { deviceId, collectedAt: Date.now(), zones };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatInfoSnapshot(info: DeviceInfoSnapshot, endpoint: string): string {
  const lines = [
    `device: ${info.deviceId} (kind=${info.kind}) @ ${endpoint} — connected`,
    `hostname: ${info.hostname ?? 'unknown'}`,
    `os: ${info.osPrettyName ?? 'unknown'} | kernel: ${info.kernel ?? 'unknown'} | arch: ${info.arch ?? 'unknown'}`,
  ];
  const cpuBits: string[] = [];
  if (info.cpuCores) cpuBits.push(`${info.cpuCores} cores`);
  if (info.cpuModel) cpuBits.push(info.cpuModel);
  if (info.hardware) cpuBits.push(`hardware: ${info.hardware}`);
  if (cpuBits.length) lines.push(`cpu: ${cpuBits.join(' | ')}`);
  const memBits: string[] = [];
  if (info.memTotalBytes) memBits.push(`${formatBytes(info.memTotalBytes)} total`);
  if (info.memAvailableBytes) memBits.push(`${formatBytes(info.memAvailableBytes)} available`);
  if (memBits.length) lines.push(`memory: ${memBits.join(' / ')}`);
  const loadBits: string[] = [];
  if (info.uptimeSeconds) loadBits.push(`uptime ${formatUptime(info.uptimeSeconds)}`);
  if (info.loadavg) loadBits.push(`load ${info.loadavg.join(' ')}`);
  if (loadBits.length) lines.push(loadBits.join(' | '));
  return lines.join('\n');
}

export function formatProcessList(snapshot: DeviceProcessListSnapshot, endpoint: string): string {
  if (snapshot.psUnsupported) {
    return (
      `Process listing unavailable on ${snapshot.deviceId}: the device ps does not support \`ps -eo\` columns.\n` +
      `Probe /proc directly with device_exec instead (e.g. \`for p in /proc/[0-9]*; do echo $p $(tr '\\0' ' ' < $p/cmdline); done\`).`
    );
  }
  const header = '  PID USER                 CPU%  MEM%    RSS_KB  COMMAND';
  const rows = snapshot.processes.slice(0, 25).map((p) => {
    const user = (p.user ?? '?').padEnd(18).slice(0, 18);
    const cpu = String(p.cpuPercent ?? 0).padStart(5);
    const mem = String(p.memPercent ?? 0).padStart(5);
    const rss = String(p.rssKb ?? 0).padStart(9);
    const cmd = p.command.length > 120 ? `${p.command.slice(0, 117)}…` : p.command;
    return `${String(p.pid).padStart(5)} ${user} ${cpu} ${mem} ${rss}  ${cmd}`;
  });
  return (
    `Top ${rows.length} of ${snapshot.processes.length} processes on ${snapshot.deviceId} (${endpoint}):\n` +
    `${header}\n${rows.join('\n')}`
  );
}

export function formatResourceSnapshot(snapshot: DeviceResourceSnapshot, endpoint: string): string {
  const lines = [`resources on ${snapshot.deviceId} (${endpoint}):`];
  if (snapshot.memTotalBytes) {
    const avail = snapshot.memAvailableBytes
      ? ` / ${formatBytes(snapshot.memAvailableBytes)} available`
      : '';
    lines.push(`memory: ${formatBytes(snapshot.memTotalBytes)} total${avail}`);
  }
  if (snapshot.loadavg) lines.push(`load: ${snapshot.loadavg.join(' ')}`);
  if (snapshot.disks.length) {
    lines.push('disks (df -P):');
    for (const disk of snapshot.disks.slice(0, 10)) {
      const total = disk.totalBytes ? formatBytes(disk.totalBytes) : '?';
      const avail = disk.availableBytes ? formatBytes(disk.availableBytes) : '?';
      lines.push(
        `  ${disk.mount} — ${total} total, ${avail} avail, ${disk.usedPercent ?? '?'}% used (${disk.filesystem})`
      );
    }
  } else {
    lines.push('disks: no df output parsed');
  }
  return lines.join('\n');
}

export function formatTemperatureSnapshot(snapshot: DeviceTemperatureSnapshot): string {
  if (snapshot.zones.length === 0) {
    return `No thermal zones exposed on ${snapshot.deviceId} (/sys/class/thermal empty).`;
  }
  const rows = snapshot.zones.map(
    (z) => `  ${z.zone}${z.label ? ` (${z.label})` : ''}: ${z.celsius}°C`
  );
  return `thermal zones on ${snapshot.deviceId}:\n${rows.join('\n')}`;
}

export const NETWORK_PROBE_SCRIPT = [
  'ip -o addr show scope global 2>/dev/null | awk \'{printf "ADDR|%s|%s|%s\\n", $2, $3, $4}\'',
  'ip route show default 2>/dev/null | awk \'{printf "ROUTE|%s\\n", $0}\'',
  'ip -o link show 2>/dev/null | awk \'{iface=$2; sub(/:$/, "", iface); state="unknown"; for (i=1; i<=NF; i++) if ($i == "state") state=$(i+1); printf "LINK|%s|%s\\n", iface, state}\'',
].join('\n');

export interface DeviceNetworkAddress {
  interface: string;
  family: string;
  cidr: string;
}

export interface DeviceNetworkSnapshot {
  deviceId: string;
  collectedAt: number;
  addresses: DeviceNetworkAddress[];
  defaultRoute?: string;
  links: Array<{ interface: string; state: string }>;
}

export function parseNetworkProbe(stdout: string, deviceId: string): DeviceNetworkSnapshot {
  const snapshot: DeviceNetworkSnapshot = {
    deviceId,
    collectedAt: Date.now(),
    addresses: [],
    links: [],
  };
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes('|')) continue;
    const sep = line.indexOf('|');
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    if (key === 'ADDR') {
      const [iface, family, cidr] = value.split('|');
      if (iface && family && cidr) snapshot.addresses.push({ interface: iface, family, cidr });
    } else if (key === 'ROUTE') {
      if (value) snapshot.defaultRoute = snapshot.defaultRoute ?? value;
    } else if (key === 'LINK') {
      const [iface, state] = value.split('|');
      if (iface) snapshot.links.push({ interface: iface, state: state ?? 'unknown' });
    }
  }
  return snapshot;
}

export function formatNetworkSnapshot(snapshot: DeviceNetworkSnapshot, endpoint: string): string {
  if (snapshot.addresses.length === 0 && snapshot.links.length === 0) {
    return `network on ${snapshot.deviceId} (${endpoint}): no interfaces parsed (ip tool missing?).`;
  }
  const lines = [`network on ${snapshot.deviceId} (${endpoint}):`];
  for (const addr of snapshot.addresses) {
    const link = snapshot.links.find((l) => l.interface === addr.interface);
    lines.push(`  ${addr.interface} (${link?.state ?? 'unknown'}): ${addr.family} ${addr.cidr}`);
  }
  for (const link of snapshot.links) {
    if (!snapshot.addresses.some((a) => a.interface === link.interface)) {
      lines.push(`  ${link.interface} (${link.state}): no global address`);
    }
  }
  if (snapshot.defaultRoute) lines.push(`  default route: ${snapshot.defaultRoute}`);
  return lines.join('\n');
}

export const CAMERAS_PROBE_SCRIPT = [
  'for n in /sys/class/video4linux/*/name; do [ -r "$n" ] || continue; printf "CAM|%s|%s\\n" "$(basename "$(dirname "$n")")" "$(cat "$n" 2>/dev/null)"; done',
  'for v in /dev/video*; do [ -e "$v" ] || continue; printf "V4L2DEV|%s\\n" "$v"; done',
].join('\n');

export interface DeviceCameraSnapshot {
  deviceId: string;
  collectedAt: number;
  cameras: Array<{ device: string; name?: string }>;
}

export function parseCamerasProbe(stdout: string, deviceId: string): DeviceCameraSnapshot {
  const nameByBase = new Map<string, string>();
  const devPaths = new Map<string, string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('CAM|')) {
      const [, device, name] = line.split('|');
      if (device) nameByBase.set(device, name || '');
    } else if (line.startsWith('V4L2DEV|')) {
      const dev = line.slice('V4L2DEV|'.length);
      if (dev) devPaths.set(dev.split('/').filter(Boolean).pop() ?? dev, dev);
    }
  }
  const bases = new Set([...nameByBase.keys(), ...devPaths.keys()]);
  return {
    deviceId,
    collectedAt: Date.now(),
    cameras: [...bases].sort().map((base) => ({
      device: devPaths.get(base) ?? base,
      ...(nameByBase.get(base) ? { name: nameByBase.get(base) } : {}),
    })),
  };
}

export function formatCamerasSnapshot(snapshot: DeviceCameraSnapshot, endpoint: string): string {
  if (snapshot.cameras.length === 0) {
    return (
      `cameras on ${snapshot.deviceId} (${endpoint}): none detected under /sys/class/video4linux.\n` +
      `If the hardware should have cameras, check the driver/bring-up before any perception work.`
    );
  }
  const rows = snapshot.cameras.map((cam) => `  ${cam.device}${cam.name ? ` — ${cam.name}` : ''}`);
  return `cameras on ${snapshot.deviceId} (${endpoint}): ${snapshot.cameras.length} v4l2 device(s)\n${rows.join('\n')}`;
}
