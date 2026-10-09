/**
 * Device operation risk tiers (2026-10-09 device safety policy).
 *
 * Pure classifier: no I/O, no policy. The approval hook decides what to do
 * with the tier; this module only names the risk.
 *
 * Tiers:
 * - readonly: probes and commands that do not change device state
 * - reversible: mutations that do not brick the board or drop access
 *   (app deploy, package install, systemctl restart, rm of a build dir)
 * - sensitive: reads of secrets (shadow, private keys, sshd_config,
 *   authorized_keys). Not damage, but still confirms / refuses headless.
 * - destructive: lockout or hard-to-undo damage (reboot, flash, system
 *   paths, network changes, package removal, ssh/account changes)
 *
 * Opaque scripts (`./flash.sh`, `python app.py`) stay reversible: their
 * bodies are not inspected. `bash -c '...'` is, because the payload is shell.
 */
export type DeviceRiskTier = 'readonly' | 'reversible' | 'sensitive' | 'destructive';

export interface DeviceRiskClassification {
  tier: DeviceRiskTier;
  /** Stable id for evidence (`reboot`, `package-remove`, …). */
  signal: string;
  reason: string;
  /** Grant key operand. Callers must pass this back to the trust ledger. */
  operand: string;
  /**
   * What answering `a` trusts for this device until the process exits.
   * Present on sensitive and destructive classifications.
   */
  trust?: DeviceSessionTrustScope;
}

/** Session scope for one `a` answer. `id` is the match key; labels are shown verbatim. */
export interface DeviceSessionTrustScope {
  id: string;
  en: string;
  zh: string;
}

export interface DeviceOperationInput {
  toolName: string;
  sideEffect?: string;
  command?: string;
  path?: string;
  remotePath?: string;
  startCommand?: string;
  healthCommand?: string;
}

const READONLY_DEVICE_TOOLS = new Set([
  'device_info',
  'device_processes',
  'device_resources',
  'device_temperature',
  'device_file_read',
  'device_file_list',
  'device_robotics_status',
  'device_network',
  'device_cameras',
]);

const TIER_RANK: Record<DeviceRiskTier, number> = {
  readonly: 0,
  reversible: 1,
  sensitive: 2,
  destructive: 3,
};

interface SegmentJudgement {
  tier: DeviceRiskTier;
  signal: string;
  reason: string;
}

function higher(a: SegmentJudgement, b: SegmentJudgement): SegmentJudgement {
  return TIER_RANK[a.tier] >= TIER_RANK[b.tier] ? a : b;
}

function hit(tier: DeviceRiskTier, signal: string, reason: string): SegmentJudgement {
  return { tier, signal, reason };
}

function commandBase(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? '';
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Split on unquoted `&&`, `||`, `;`, `|`, and newlines. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      push();
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      push();
      i += 1;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      push();
      i += 1;
      continue;
    }
    if (ch === '|') {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

function extractSubstitutions(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/\$\(([^()]*)\)/g)) {
    if (match[1]) out.push(match[1]);
  }
  for (const match of command.matchAll(/`([^`]*)`/g)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

function skipShellToken(text: string, index: number): number {
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (i >= text.length) return i;
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, i + 1);
    return end === -1 ? text.length : end + 1;
  }
  while (
    i < text.length &&
    text[i] !== ' ' &&
    text[i] !== '\t' &&
    text[i] !== ';' &&
    text[i] !== '|' &&
    text[i] !== '&'
  ) {
    i += 1;
  }
  return i;
}

function readShellToken(text: string, index: number): { token: string; next: number } {
  const start = index;
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  const tokenStart = i;
  i = skipShellToken(text, i);
  return { token: text.slice(tokenStart, i), next: i === start ? text.length : i };
}

/** Peel one sudo/env/timeout/assignment leader. Null when the segment is already the command. */
function stripOneLeader(rest: string): string | null {
  const headMatch = /^(sudo|doas|nice|time|nohup|stdbuf|ionice|env|timeout|command)\b/.exec(rest);
  if (!headMatch) {
    const assigned = /^(?:[A-Za-z_][\w]*)=(?:'[^']*'|"[^"]*"|[^\s]+)\s+/.exec(rest);
    return assigned?.[0] ? rest.slice(assigned[0].length) : null;
  }
  const name = headMatch[1] ?? '';
  // `command -v` / `command -V` prints a path; it does not execute the name.
  if (name === 'command' && /^\s+-[vV]\b/.test(rest.slice(name.length))) return null;

  let i = name.length;
  const sudoValueFlags = new Set(['-u', '-g', '--user', '--group', '-C', '--close-from']);
  const envValueFlags = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
  const timeoutValueFlags = new Set(['-k', '--kill-after', '-s', '--signal']);

  const consumeFlags = (valueFlags: Set<string>): void => {
    while (i < rest.length) {
      while (rest[i] === ' ' || rest[i] === '\t') i += 1;
      if (rest.startsWith('--', i) && (rest[i + 2] === undefined || /\s/.test(rest[i + 2] ?? ''))) {
        i += 2;
        break;
      }
      if (rest[i] !== '-') break;
      const flag = readShellToken(rest, i);
      i = flag.next;
      if (valueFlags.has(flag.token)) i = skipShellToken(rest, i);
    }
  };

  if (name === 'sudo' || name === 'doas') consumeFlags(sudoValueFlags);
  else if (name === 'env') consumeFlags(envValueFlags);
  else if (name === 'timeout') {
    consumeFlags(timeoutValueFlags);
    i = skipShellToken(rest, i);
  } else if (name === 'nice' || name === 'ionice' || name === 'stdbuf') {
    consumeFlags(new Set(['-n', '--adjustment', '-c', '--class', '-o', '--output', '-e']));
  } else if (name !== 'command') {
    consumeFlags(new Set());
  }

  if (name === 'env') {
    while (i < rest.length) {
      const saved = i;
      const next = readShellToken(rest, i);
      if (/^[A-Za-z_][\w]*=/.test(next.token)) {
        i = next.next;
        continue;
      }
      i = saved;
      break;
    }
  }
  return rest.slice(i);
}

const LEADER_NAMES = new Set([
  'sudo',
  'doas',
  'nice',
  'time',
  'nohup',
  'stdbuf',
  'ionice',
  'env',
  'timeout',
  'command',
]);

function stripWrappers(segment: string): string {
  let rest = segment.trim();
  for (let guard = 0; guard < 8 && rest; guard++) {
    const first = readShellToken(rest, 0);
    const base = commandBase(first.token);
    const normalized =
      first.token && base !== first.token && LEADER_NAMES.has(base)
        ? `${base}${rest.slice(first.next)}`
        : rest;
    const next = stripOneLeader(normalized);
    if (next === null) break;
    const trimmed = next.trim();
    if (!trimmed || trimmed === rest) break;
    rest = trimmed;
  }
  return rest;
}

function collapseAbsolute(path: string): string {
  if (!path.startsWith('/')) return path;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function isBlockDevicePath(raw: string): boolean {
  const path = collapseAbsolute(raw.trim());
  return /^\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+|vd[a-z]\d*|hd[a-z]\d*|mmcblk\d+|mtd\d+|disk\d*)/i.test(
    path
  );
}

function isSensitiveCredentialPath(raw: string): boolean {
  const path = raw.replace(/\\/g, '/').toLowerCase();
  if (!path.includes('/')) return false;
  return (
    path.includes('/etc/shadow') ||
    path.includes('/etc/sudoers') ||
    path.includes('/etc/gshadow') ||
    path.includes('/.ssh/') ||
    path.endsWith('/authorized_keys') ||
    path.endsWith('/sshd_config') ||
    path.endsWith('/id_rsa') ||
    path.endsWith('/id_ed25519') ||
    path.endsWith('/id_ecdsa')
  );
}

function expandHome(raw: string): string {
  const path = raw.trim().replace(/[;,]+$/, '');
  if (path === '~' || path === '~/' || path === '$HOME' || path === '${HOME}') return '/home/_user';
  if (path.startsWith('~/')) return `/home/_user/${path.slice(2)}`;
  if (path.startsWith('$HOME/')) return `/home/_user/${path.slice('$HOME/'.length)}`;
  if (path.startsWith('${HOME}/')) return `/home/_user/${path.slice('${HOME}/'.length)}`;
  return path;
}

/** System, boot, account, or ssh paths. `/opt/<app>`, `/home/<user>/...`, `/tmp` are not. */
export function isLockoutPath(raw: string): boolean {
  let path = expandHome(raw);
  if (!path) return false;
  if (path === '/' || path === '/*' || path === '/home' || path === '/home/') return true;
  if (path.endsWith('/*') || path.endsWith('/**')) {
    return isLockoutPath(path.replace(/\/\*\*?$/, '') || '/');
  }
  path = collapseAbsolute(path);
  const compact = path.replace(/\/+$/, '') || '/';
  if (
    compact === '/' ||
    compact === '/home' ||
    compact === '/root' ||
    compact === '/opt' ||
    compact === '/var' ||
    compact === '/usr' ||
    compact === '/bin' ||
    compact === '/sbin' ||
    compact === '/lib' ||
    compact === '/lib64'
  ) {
    return true;
  }
  if (/^\/home\/[^/]+$/.test(compact)) return true;
  const lower = compact.toLowerCase();
  if (lower === '/usr/local' || lower.startsWith('/usr/local/')) return false;
  if (isSensitiveCredentialPath(lower) || lower.includes('/.ssh/') || lower.startsWith('/.ssh')) {
    return true;
  }
  if (isBlockDevicePath(lower)) return true;
  return (
    lower.startsWith('/boot') ||
    lower.startsWith('/etc') ||
    lower.startsWith('/usr/') ||
    lower.startsWith('/bin/') ||
    lower.startsWith('/sbin/') ||
    lower.startsWith('/lib/') ||
    lower.startsWith('/lib64/') ||
    lower.startsWith('/root/') ||
    lower.startsWith('/sys') ||
    lower.startsWith('/proc')
  );
}

function redirectionTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const isRedirect =
      ch === '>' || (ch === '&' && command[i + 1] === '>' && command[i + 2] !== '&');
    if (!isRedirect) continue;
    // `2>&1` and `>&1` duplicate a file descriptor; they are not paths.
    if (command[i + 1] === '&' && /\d/.test(command[i + 2] ?? '')) continue;
    let k = ch === '&' ? i + 2 : i + 1;
    if (command[k] === '>') k += 1;
    while (command[k] === ' ' || command[k] === '\t') k += 1;
    if (command[k] === '&') continue;
    let target = '';
    const opener = command[k];
    if (opener === '"' || opener === "'") {
      const end = command.indexOf(opener, k + 1);
      target = command.slice(k + 1, end === -1 ? command.length : end);
      k = end === -1 ? command.length : end;
    } else {
      while (
        k < command.length &&
        !/\s/.test(command[k] ?? '') &&
        command[k] !== ';' &&
        command[k] !== '&' &&
        command[k] !== '|' &&
        command[k] !== ')'
      ) {
        target += command[k];
        k += 1;
      }
    }
    if (target) targets.push(target);
    i = Math.max(k, i);
  }
  return targets;
}

function redirectJudgement(command: string): SegmentJudgement | null {
  const targets = redirectionTargets(command);
  let write: SegmentJudgement | null = null;
  for (const target of targets) {
    if (
      target === '/dev/null' ||
      target === '/dev/tty' ||
      target === '/dev/stdout' ||
      target === '/dev/stderr'
    ) {
      continue;
    }
    if (isBlockDevicePath(target)) {
      return hit('destructive', 'redirect-block-device', `redirection into block device ${target}`);
    }
    if (isLockoutPath(target)) {
      return hit('destructive', 'redirect-system-path', `redirection into system path ${target}`);
    }
    write = hit('reversible', 'redirect-file', `redirection writes ${target}`);
  }
  return write;
}

const READONLY_NAMES = new Set([
  'pwd',
  'ls',
  'tree',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'whoami',
  'id',
  'uname',
  'hostname',
  'date',
  'df',
  'du',
  'free',
  'ps',
  'pgrep',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'stat',
  'file',
  'which',
  'type',
  'printenv',
  'uptime',
  'lscpu',
  'lsusb',
  'lspci',
  'lsblk',
  'lsof',
  'dmesg',
  'journalctl',
  'hostnamectl',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ping',
  'ss',
  'netstat',
  'timedatectl',
  'lsmod',
  'fw_printenv',
]);

const READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'awk',
  'sed',
]);

const READONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'grep',
  'remote',
]);

const SYSTEM_PKG = new Set([
  'apt',
  'apt-get',
  'aptitude',
  'dpkg',
  'yum',
  'dnf',
  'pacman',
  'opkg',
  'snap',
  'zypper',
  'apk',
]);

const FLASH_TOOLS = new Set([
  'fastboot',
  'rkdeveloptool',
  'upgrade_tool',
  'sunxi-fel',
  'flashcp',
  'bmaptool',
  'imx_usb',
  'uuu',
  'rkflash',
  'emmc_tool',
  'flash_erase',
  'nandwrite',
  'mtd_debug',
]);

function rmOperands(args: string[]): string[] {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) continue;
    operands.push(arg);
  }
  return operands;
}

function classifyCopyMove(base: string, args: string[]): SegmentJudgement {
  const operands = rmOperands(args);
  const dest = operands[operands.length - 1] ?? '';
  const remoteSystem = /:(?:\/boot|\/etc|\/usr|\/bin|\/sbin|\/lib|\/root)(?:\/|$)/;
  if (base === 'mv' && operands.some((path) => isLockoutPath(path) || isBlockDevicePath(path))) {
    return hit('destructive', 'move-system-path', `${base} of a system path`);
  }
  if (dest && (isLockoutPath(dest) || isBlockDevicePath(dest) || remoteSystem.test(dest))) {
    return hit('destructive', 'copy-system-path', `${base} into a system path ${dest}`);
  }
  return hit('reversible', 'reversible-command', `${base} of a non-system path`);
}

const FLASH_NAME_WORDS = new Set([
  'flash',
  'burn',
  'xburn',
  'ota',
  'mkfs',
  'upgrade_firmware',
  'hb_ota',
]);

function flashToken(token: string): boolean {
  const base = commandBase(token).replace(/^-+/, '').toLowerCase();
  const stem = base.replace(/\.(?:sh|py|bin|elf|img|run|pl|rb|js|bash)$/i, '');
  if (FLASH_NAME_WORDS.has(stem) || stem.includes('upgrade_firmware') || stem.includes('hb_ota')) {
    return true;
  }
  return stem.split(/[^a-z0-9]+/).some((part) => FLASH_NAME_WORDS.has(part));
}

function looksLikeFlashInvocation(base: string, args: string[]): boolean {
  if (flashToken(base)) return true;
  const interpreters = new Set([
    'python',
    'python2',
    'python3',
    'perl',
    'ruby',
    'node',
    'bash',
    'sh',
    'zsh',
    'dash',
  ]);
  if (!interpreters.has(base)) return false;
  const script = args.find((arg) => !arg.startsWith('-'));
  return script ? flashToken(script) : false;
}

function classifyRm(base: string, args: string[]): SegmentJudgement {
  const operands = rmOperands(args);
  if (operands.length === 0) {
    return hit('destructive', 'rm-lockout', `${base} with no target`);
  }
  for (const operand of operands) {
    if (operand === '*' || operand === '.*' || operand === './*' || operand === '/*') {
      return hit('destructive', 'rm-lockout', `${base} of an unbounded glob`);
    }
    if (isLockoutPath(operand)) {
      return hit('destructive', 'rm-lockout', `${base} of lockout path ${operand}`);
    }
  }
  return hit('reversible', 'rm-local', `${base} of a non-system path`);
}

function classifySystemctl(args: string[]): SegmentJudgement {
  const knownReadonly = new Set([
    'status',
    'is-active',
    'is-failed',
    'is-enabled',
    'show',
    'list-units',
    'list-unit-files',
    'list-sockets',
    'list-timers',
    'list-dependencies',
    'cat',
    'get-default',
    'show-environment',
    'help',
  ]);
  const knownDestructive = new Set([
    'stop',
    'disable',
    'mask',
    'kill',
    'isolate',
    'emergency',
    'rescue',
    'reboot',
    'poweroff',
    'halt',
    'kexec',
    'daemon-reexec',
    'edit',
    'set-property',
    'set-default',
    'switch-root',
  ]);
  const knownReversible = new Set([
    'start',
    'restart',
    'reload',
    'try-restart',
    'reload-or-restart',
    'enable',
    'unmask',
    'reset-failed',
    'link',
    'daemon-reload',
  ]);
  const verb = args.find(
    (arg) => knownReadonly.has(arg) || knownDestructive.has(arg) || knownReversible.has(arg)
  );
  if (!verb || knownReadonly.has(verb)) {
    return hit('readonly', 'systemd-query', 'systemctl read-only query');
  }
  if (verb === 'daemon-reload') {
    return hit('reversible', 'systemd-reload', 'systemctl daemon-reload reloads unit files');
  }
  if (knownDestructive.has(verb)) {
    // Critical-unit denylist, not a session ledger of unit files Moss wrote.
    // Tracking files created over SSH is easy to spoof (any unit name) and
    // would couple the classifier to the task store. Stop/disable/mask of
    // anything not on this list — including units the operator deployed — is
    // reversible. --user is a user manager, not sshd/NetworkManager.
    if (verb === 'stop' || verb === 'disable' || verb === 'mask' || verb === 'kill') {
      if (args.includes('--user')) {
        return hit('reversible', 'systemd-user', `systemctl --user ${verb} changes a user unit`);
      }
      const units = args.filter((arg) => !arg.startsWith('-') && arg !== verb);
      if (units.length > 0 && units.every((unit) => !isCriticalSystemdUnit(unit))) {
        return hit('reversible', 'systemd-app', `systemctl ${verb} of a non-critical unit`);
      }
      return hit(
        'destructive',
        'systemd-lockout',
        `systemctl ${verb} of a critical unit or with no unit name`
      );
    }
    return hit('destructive', 'systemd-lockout', `systemctl ${verb} can drop services or boot`);
  }
  return hit('reversible', 'systemd-restart', `systemctl ${verb} is reversible`);
}

/** ssh, networking, and dbus. Other units are treated as the operator's services. */
function isCriticalSystemdUnit(name: string): boolean {
  const base = unitBaseName(name).toLowerCase();
  return (
    base === 'ssh' ||
    base === 'sshd' ||
    base === 'networking' ||
    base === 'networkmanager' ||
    base === 'systemd-networkd' ||
    base === 'wpa_supplicant' ||
    base === 'dbus'
  );
}

function classifyIp(args: string[], depth = 0): SegmentJudgement {
  const words = args.filter((arg) => !arg.startsWith('-'));
  if (words[0] === 'netns' && words[1] === 'exec') {
    const cmd = words.slice(3);
    const head = cmd[0];
    if (!head) return hit('destructive', 'network-change', 'ip netns exec with no command');
    if (depth >= 4) return hit('destructive', 'network-change', 'ip netns exec nested too deep');
    return classifyNamedCommand(commandBase(head), cmd.slice(1), cmd.join(' '), depth + 1);
  }
  const mutating = new Set(['add', 'del', 'delete', 'flush', 'set', 'replace', 'change', 'append']);
  if (words.some((word) => mutating.has(word))) {
    return hit('destructive', 'network-change', 'ip command changes addresses, links, or routes');
  }
  return hit('readonly', 'network-query', 'ip display command');
}

function classifyNmcli(args: string[]): SegmentJudgement {
  const mutating = new Set([
    'up',
    'down',
    'add',
    'modify',
    'delete',
    'reload',
    'connect',
    'disconnect',
    'clone',
    'edit',
    'import',
    'load',
    'on',
    'off',
  ]);
  const words = args.filter((arg) => !arg.startsWith('-'));
  if (words.some((word) => mutating.has(word))) {
    return hit('destructive', 'network-change', 'nmcli changes a connection or device');
  }
  return hit('readonly', 'network-query', 'nmcli display command');
}

function classifyPackage(base: string, args: string[]): SegmentJudgement {
  const joined = args.join(' ');
  if (base === 'dpkg') {
    if (/(?:^|\s)(?:-r|-P|--remove|--purge)(?:\s|$)/.test(joined)) {
      return hit('destructive', 'package-remove', 'dpkg remove/purge');
    }
    if (/(?:^|\s)(?:-l|-s|-L|-c|--list|--status|--contents)(?:\s|$)/.test(joined)) {
      return hit('readonly', 'package-query', 'dpkg query');
    }
    return hit('reversible', 'package-change', 'dpkg change');
  }
  if (base === 'pacman') {
    if (/(?:^|\s)(?:-R\w*|--remove)(?:\s|$)/.test(` ${joined}`)) {
      return hit('destructive', 'package-remove', 'pacman remove');
    }
    if (/(?:^|\s)-Q/.test(` ${joined}`)) {
      return hit('readonly', 'package-query', 'pacman query');
    }
    return hit('reversible', 'package-change', 'pacman change');
  }
  const verb = args.find((arg) => !arg.startsWith('-'));
  if (verb && ['remove', 'purge', 'autoremove', 'erase', 'uninstall'].includes(verb)) {
    return hit('destructive', 'package-remove', `${base} ${verb}`);
  }
  if (verb && ['list', 'show', 'search', 'policy', 'info', 'depends', 'rdepends'].includes(verb)) {
    return hit('readonly', 'package-query', `${base} ${verb}`);
  }
  return hit('reversible', 'package-change', `${base} ${verb ?? 'change'}`);
}

function classifyNamedCommand(
  base: string,
  args: string[],
  raw: string,
  depth = 0
): SegmentJudgement {
  if (base === 'busybox') {
    const applet = args[0];
    if (!applet) return hit('reversible', 'reversible-command', 'busybox with no applet');
    return classifyNamedCommand(commandBase(applet), args.slice(1), raw, depth);
  }

  if (LEADER_NAMES.has(base) && !(base === 'command' && (args[0] === '-v' || args[0] === '-V'))) {
    const peeled = stripWrappers(`${base} ${args.join(' ')}`);
    const tokens = tokenize(peeled);
    const head = tokens[0];
    if (head && commandBase(head) !== base) {
      return classifyNamedCommand(commandBase(head), tokens.slice(1), peeled, depth);
    }
  }

  if (
    base === 'reboot' ||
    base === 'shutdown' ||
    base === 'poweroff' ||
    base === 'halt' ||
    base === 'telinit'
  ) {
    return hit('destructive', 'reboot', `${base} resets or powers off the board`);
  }
  if (base === 'init' && (args[0] === '0' || args[0] === '6')) {
    return hit('destructive', 'reboot', `init ${args[0]} halts or reboots`);
  }

  if (FLASH_TOOLS.has(base) || base === 'mkfs' || base.startsWith('mkfs.') || base === 'wipefs') {
    return hit('destructive', 'flash-or-format', `${base} formats or flashes storage`);
  }
  if (base === 'fw_setenv') {
    return hit('destructive', 'flash-or-format', 'fw_setenv changes boot firmware environment');
  }
  if (base === 'fdisk' || base === 'sfdisk' || base === 'parted') {
    if (args.includes('-l') || args.includes('--list')) {
      return hit('readonly', 'readonly-command', `${base} list`);
    }
    return hit('destructive', 'flash-or-format', `${base} edits a partition table`);
  }
  if (base === 'shred') {
    return hit('destructive', 'flash-or-format', 'shred overwrites data irrecoverably');
  }

  if (base === 'dd') {
    const ofArg = args.find((arg) => arg.startsWith('of='));
    if (!ofArg) return hit('destructive', 'dd-device', 'dd without an of= target');
    const target = ofArg.slice('of='.length);
    if (isBlockDevicePath(target) || isLockoutPath(target)) {
      return hit('destructive', 'dd-device', `dd writes ${target}`);
    }
    return hit('reversible', 'dd-file', `dd writes regular file ${target}`);
  }

  if (base === 'rm' || base === 'rmdir' || base === 'unlink') {
    return classifyRm(base, args);
  }

  if (
    base === 'passwd' ||
    base === 'chpasswd' ||
    base === 'usermod' ||
    base === 'useradd' ||
    base === 'userdel' ||
    base === 'groupadd' ||
    base === 'groupdel' ||
    base === 'groupmod' ||
    base === 'visudo' ||
    base === 'chsh' ||
    base === 'chfn' ||
    base === 'newusers'
  ) {
    return hit('destructive', 'credential-or-account', `${base} changes accounts or credentials`);
  }

  if (base === 'systemctl' || base === 'service') {
    return classifySystemctl(args);
  }

  if (base === 'iptables' || base === 'ip6tables' || base === 'nft' || base === 'firewall-cmd') {
    const listing =
      args.includes('-L') ||
      args.includes('-S') ||
      args.includes('--list') ||
      args.includes('--list-rules') ||
      args.includes('list') ||
      (base === 'firewall-cmd' && args.some((arg) => arg.startsWith('--list')));
    const mutating = args.some((arg) =>
      ['-A', '-I', '-D', '-F', '-X', '-P', '--flush'].includes(arg)
    );
    if (listing && !mutating) {
      return hit('readonly', 'network-query', `${base} list`);
    }
    return hit('destructive', 'network-change', `${base} changes the firewall`);
  }
  if (base === 'iptables-save' || base === 'ip6tables-save') {
    return hit('readonly', 'network-query', `${base} dumps rules`);
  }
  if (base === 'iptables-restore' || base === 'ip6tables-restore') {
    return hit('destructive', 'network-change', `${base} replaces firewall rules`);
  }
  if (base === 'ufw') {
    const verb = args.find((arg) => !arg.startsWith('-'));
    if (!verb || verb === 'status') return hit('readonly', 'network-query', 'ufw status');
    return hit('destructive', 'network-change', `ufw ${verb}`);
  }
  if (base === 'ip') return classifyIp(args, depth);
  if (base === 'nmcli') return classifyNmcli(args);

  if (SYSTEM_PKG.has(base)) return classifyPackage(base, args);

  if (base === 'mount' || base === 'umount' || base === 'swapon' || base === 'swapoff') {
    return hit('destructive', 'mount', `${base} changes the mount table`);
  }

  if (base === 'chmod' || base === 'chown' || base === 'chgrp') {
    const operands = rmOperands(args);
    if (operands.some((operand) => isLockoutPath(operand) || operand === '/')) {
      return hit('destructive', 'permission-lockout', `${base} of a system path`);
    }
    return hit('reversible', 'permission-change', `${base} of a non-system path`);
  }

  if (base === 'kill' || base === 'killall' || base === 'pkill') {
    if (args.some((arg) => arg === '-1' || arg === '-- -1')) {
      return hit('destructive', 'kill-all', 'kill -1 signals every process');
    }
    return hit('reversible', 'kill-process', `${base} of a specific process`);
  }

  if (READERS.has(base) && args.some((arg) => isSensitiveCredentialPath(arg))) {
    return hit('sensitive', 'credential-read', `${base} reads a credential or ssh file`);
  }

  if (base === 'git') {
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (
      sub === 'push' &&
      args.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('--force='))
    ) {
      return hit('destructive', 'git-force-push', 'git push --force');
    }
    if (sub && READONLY_GIT.has(sub)) {
      return hit('readonly', 'readonly-command', `git ${sub}`);
    }
    return hit('reversible', 'reversible-command', `git ${sub ?? 'command'}`);
  }

  if (base === 'sed') {
    if (args.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
      const operands = args.filter((arg) => !arg.startsWith('-'));
      if (operands.some((operand) => isLockoutPath(operand))) {
        return hit('destructive', 'redirect-system-path', 'sed -i edits a system path');
      }
      return hit('reversible', 'reversible-command', 'sed -i edits a file');
    }
    return hit('readonly', 'readonly-command', 'sed read');
  }

  if (base === 'find') {
    if (args.includes('-delete')) {
      const paths = args.filter((arg) => !arg.startsWith('-'));
      if (paths.some((path) => isLockoutPath(path))) {
        return hit('destructive', 'rm-lockout', 'find -delete of a system path');
      }
      return hit('reversible', 'rm-local', 'find -delete of a non-system path');
    }
    const execAt = args.findIndex((arg) => arg === '-exec' || arg === '-execdir' || arg === '-ok');
    if (execAt >= 0) {
      const tail = args.slice(execAt + 1).filter((arg) => arg !== '{}');
      const end = tail.findIndex((arg) => arg === ';' || arg === '+');
      const inner = end >= 0 ? tail.slice(0, end) : tail;
      const head = inner[0];
      if (!head) return hit('destructive', 'find-exec', 'find -exec with no command');
      return classifyNamedCommand(commandBase(head), inner.slice(1), inner.join(' '), depth);
    }
    return hit('readonly', 'readonly-command', 'find without -exec or -delete');
  }

  if (base === 'awk' && /\bsystem\s*\(/.test(raw)) {
    return hit('destructive', 'awk-system', 'awk system() runs a shell command');
  }
  if (base === 'tar' && raw.includes('--checkpoint-action')) {
    return hit('destructive', 'tar-checkpoint', 'tar --checkpoint-action runs a command');
  }
  if ((base === 'vim' || base === 'vi' || base === 'nano') && !args.includes('--version')) {
    return hit('destructive', 'editor-escape', `${base} can escape to a shell`);
  }

  if (base === 'crontab') {
    if (args.includes('-l') || args.includes('-h')) {
      return hit('readonly', 'readonly-command', 'crontab list');
    }
    return hit('destructive', 'cron-change', 'crontab edits scheduled jobs');
  }

  if (
    (base === 'bash' || base === 'sh' || base === 'zsh' || base === 'dash') &&
    (args.includes('-c') || args.includes('-lc'))
  ) {
    const flagAt = args.findIndex((arg) => arg === '-c' || arg === '-lc');
    const payload = args[flagAt + 1];
    if (payload && depth < 4) return classifyCommand(payload, depth + 1).judgement;
  }

  if (base === 'tee') {
    const operands = args.filter((arg) => !arg.startsWith('-'));
    if (operands.some((operand) => isLockoutPath(operand) || isBlockDevicePath(operand))) {
      return hit('destructive', 'redirect-system-path', 'tee writes a system path');
    }
    if (operands.length > 0) return hit('reversible', 'redirect-file', 'tee writes a file');
  }

  if (
    base === 'cp' ||
    base === 'mv' ||
    base === 'install' ||
    base === 'ln' ||
    base === 'rsync' ||
    base === 'scp'
  ) {
    return classifyCopyMove(base, args);
  }

  if (base === 'ifconfig') {
    const words = args.filter((arg) => !arg.startsWith('-'));
    const changes = words.some(
      (word) =>
        word === 'up' ||
        word === 'down' ||
        word === 'add' ||
        word === 'del' ||
        word === 'delete' ||
        /^\d+\.\d+\.\d+\.\d+/.test(word)
    );
    if (words.length === 0 || !changes) {
      return hit('readonly', 'network-query', 'ifconfig display');
    }
    return hit('destructive', 'network-change', 'ifconfig changes an interface');
  }

  if (base === 'eval') {
    const payload = args.join(' ');
    if (!payload || payload.includes('$')) {
      return hit('destructive', 'eval-escape', 'eval runs a shell string that is not visible');
    }
    if (depth < 4) return classifyCommand(payload, depth + 1).judgement;
  }

  if (base === 'xargs') {
    const valueFlags = new Set(['-n', '-I', '-i', '-P', '-L', '-s', '-a', '-d', '-E', '-J']);
    let index = 0;
    while (index < args.length) {
      const arg = args[index] ?? '';
      if (arg === '--') {
        index += 1;
        break;
      }
      if (arg.startsWith('-')) {
        index += valueFlags.has(arg) ? 2 : 1;
        continue;
      }
      break;
    }
    const rest = args.slice(index);
    const head = rest[0];
    if (!head) return hit('destructive', 'xargs', 'xargs with no visible command');
    return classifyNamedCommand(commandBase(head), rest.slice(1), rest.join(' '), depth);
  }

  if (base === 'ssh') {
    if (args.includes('-V')) return hit('readonly', 'readonly-command', 'ssh version');
    const valueFlags = new Set([
      '-i',
      '-p',
      '-l',
      '-o',
      '-F',
      '-J',
      '-W',
      '-b',
      '-c',
      '-D',
      '-L',
      '-R',
      '-S',
      '-E',
      '-w',
      '-m',
      '-B',
      '-e',
      '-Q',
    ]);
    let index = 0;
    while (index < args.length) {
      const arg = args[index] ?? '';
      if (arg === '--') {
        index += 1;
        break;
      }
      if (arg.startsWith('-')) {
        index += valueFlags.has(arg) ? 2 : 1;
        continue;
      }
      break;
    }
    const remote = args.slice(index + 1);
    if (remote.length === 0) {
      return hit('destructive', 'ssh-escape', 'ssh opens a shell on another host');
    }
    if (depth >= 4) return hit('destructive', 'ssh-escape', 'ssh remote command nested too deep');
    return classifyCommand(remote.join(' '), depth + 1).judgement;
  }

  if (looksLikeFlashInvocation(base, args)) {
    return hit('destructive', 'flash-or-format', `${base} looks like a flash, format, or OTA tool`);
  }

  if (READONLY_NAMES.has(base)) {
    return hit('readonly', 'readonly-command', `${base} does not change device state`);
  }

  if (base === 'ros2') {
    const sub = args.filter((arg) => !arg.startsWith('-'));
    const joined = sub.join(' ');
    if (
      /^(node|topic|service|interface|param|pkg)\s+(list|info|echo|hz|bw|type|find|show)\b/.test(
        joined
      ) ||
      joined === 'node list' ||
      joined.startsWith('topic list') ||
      joined.startsWith('topic echo') ||
      joined.startsWith('topic hz')
    ) {
      return hit('readonly', 'readonly-command', `ros2 ${joined}`);
    }
    return hit('reversible', 'reversible-command', `ros2 ${joined || 'command'}`);
  }

  return hit(
    'reversible',
    'reversible-command',
    `${base || 'command'} is not a known lockout pattern`
  );
}

const PIPE_TO_SHELL =
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:env\s+)?(?:\/[\w.-]+\/)*\w*(?:sh|bash|zsh|dash|python3?|perl|ruby|node)\b/i;
const SUBST_DOWNLOAD = /\$\(\s*(?:curl|wget)\b|`\s*(?:curl|wget)\b/i;
const PROCESS_SUBST =
  /\b(?:sh|bash|zsh|dash)\s+<\(\s*(?:curl|wget)\b|\b(?:source|eval)\b[^|\n]*\b(?:curl|wget)\b/i;
const BASE64_EXEC = /\bbase64\b[^|\n]*\|\s*(?:sh|bash|zsh|dash)\b/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

function rawDanger(command: string): SegmentJudgement | null {
  if (FORK_BOMB.test(command)) {
    return hit('destructive', 'fork-bomb', 'fork bomb');
  }
  if (
    PIPE_TO_SHELL.test(command) ||
    SUBST_DOWNLOAD.test(command) ||
    PROCESS_SUBST.test(command) ||
    BASE64_EXEC.test(command)
  ) {
    return hit('destructive', 'pipe-to-shell', 'downloads a script and executes it');
  }
  return null;
}

function classifyCommand(
  command: string,
  depth = 0
): { judgement: SegmentJudgement; operand: string } {
  const operand = command;
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      judgement: hit('readonly', 'empty-command', 'empty device command'),
      operand,
    };
  }
  const raw = rawDanger(trimmed);
  if (raw) return { judgement: raw, operand };
  const pieces = [...splitShellSegments(trimmed), ...extractSubstitutions(trimmed)];
  if (pieces.length === 0) {
    return {
      judgement: hit('readonly', 'readonly-command', 'read-only device command'),
      operand,
    };
  }
  let best: SegmentJudgement | null = null;
  for (const piece of pieces) {
    const redirect = redirectJudgement(piece);
    const stripped = stripWrappers(piece);
    const tokens = tokenize(stripped);
    let judged: SegmentJudgement;
    if (tokens.length === 0) {
      judged = redirect ?? hit('readonly', 'empty-command', 'empty segment');
    } else {
      const named = classifyNamedCommand(
        commandBase(tokens[0] ?? ''),
        tokens.slice(1),
        stripped,
        depth
      );
      judged = redirect ? higher(named, redirect) : named;
      if (redirect?.tier === 'destructive') judged = redirect;
    }
    best = best ? higher(best, judged) : judged;
  }
  return {
    judgement: best ?? hit('readonly', 'readonly-command', 'read-only device command'),
    operand,
  };
}

function classifyWritePath(path: string): SegmentJudgement {
  if (!path.trim()) {
    return hit('destructive', 'write-system-path', 'device write with an empty path');
  }
  if (isBlockDevicePath(path) || isLockoutPath(path)) {
    return hit('destructive', 'write-system-path', `write to lockout path ${path}`);
  }
  return hit('reversible', 'write-app-path', `write to ${path}`);
}

const SYSTEMD_VERBS = new Set([
  'start',
  'stop',
  'restart',
  'reload',
  'try-restart',
  'reload-or-restart',
  'enable',
  'disable',
  'mask',
  'unmask',
  'kill',
  'status',
  'reboot',
  'poweroff',
  'halt',
]);

function unitBaseName(name: string): string {
  const bare = name.split('/').pop() ?? name;
  return bare
    .replace(/@.*/, '')
    .replace(/\.(service|socket|target|device|mount|timer|path|slice)$/i, '');
}

function prefixTrustScope(command: string): DeviceSessionTrustScope {
  const tokens = tokenize(stripWrappers(command.split('\n')[0] ?? command));
  const prefix = tokens.slice(0, Math.min(4, tokens.length)).join(' ') || command.trim();
  return {
    id: `prefix:${prefix}`,
    en: `commands starting with "${prefix}" on this device`,
    zh: `本机上以「${prefix}」开头的命令`,
  };
}

function powerTrustScope(): DeviceSessionTrustScope {
  return {
    id: 'power',
    en: 'reboot, shutdown, poweroff, and halt on this device',
    zh: '本机上的 reboot、shutdown、poweroff 和 halt',
  };
}

/**
 * What `a` trusts. Power commands share one scope. systemctl stop/restart of
 * one unit share one scope; disable/mask of that unit is a different scope.
 * Everything else is the command's leading words, not the whole destructive tier.
 */
export function deviceSessionTrustScope(classification: {
  tier: DeviceRiskTier;
  signal: string;
  operand: string;
}): DeviceSessionTrustScope | null {
  if (classification.tier !== 'destructive' && classification.tier !== 'sensitive') return null;
  const command = classification.operand.split('\n')[0] ?? classification.operand;
  if (classification.tier === 'sensitive') {
    const tokens = tokenize(command);
    const path = tokens.find((token) => isSensitiveCredentialPath(token)) ?? command.trim();
    return {
      id: `read:${path}`,
      en: `reading ${path} on this device`,
      zh: `读取本机上的 ${path}`,
    };
  }
  if (classification.signal === 'reboot') return powerTrustScope();
  const tokens = tokenize(stripWrappers(command));
  const base = commandBase(tokens[0] ?? '');
  if (base === 'systemctl' || base === 'service') {
    const args = tokens.slice(1);
    const user = args.includes('--user');
    const words = args.filter((arg) => !arg.startsWith('-'));
    const verb = base === 'service' ? words[1] : words.find((word) => SYSTEMD_VERBS.has(word));
    const unit = base === 'service' ? words[0] : words.find((word) => word !== verb);
    if (verb === 'reboot' || verb === 'poweroff' || verb === 'halt') return powerTrustScope();
    if (unit && (verb === 'stop' || verb === 'restart' || verb === 'start' || verb === 'kill')) {
      const name = unitBaseName(unit);
      const who = user ? ' (user unit)' : '';
      const whoZh = user ? '（用户单元）' : '';
      return {
        id: `systemd:cycle:${user ? 'user:' : ''}${name}`,
        en: `systemctl restart or stop of ${name}${who} on this device`,
        zh: `本机上 systemctl restart 或 stop ${name}${whoZh}`,
      };
    }
    if (unit && (verb === 'disable' || verb === 'mask')) {
      const name = unitBaseName(unit);
      return {
        id: `systemd:persist:${user ? 'user:' : ''}${name}`,
        en: `systemctl disable or mask of ${name} on this device`,
        zh: `本机上 systemctl disable 或 mask ${name}`,
      };
    }
  }
  return prefixTrustScope(command);
}

function withTrust(body: Omit<DeviceRiskClassification, 'trust'>): DeviceRiskClassification {
  const trust = deviceSessionTrustScope(body);
  return trust ? { ...body, trust } : body;
}

/**
 * Classify one device tool call. Returns null for tools that are not device
 * operations. Unknown `device_mutation` tools (no command/path shape) are
 * reversible so full mode stays fast; only recognized lockout patterns escalate.
 */
export function classifyDeviceOperation(
  input: DeviceOperationInput
): DeviceRiskClassification | null {
  if (input.toolName === 'device_file_read') {
    const path = input.path ?? '';
    if (isSensitiveCredentialPath(path)) {
      return withTrust({
        tier: 'sensitive',
        signal: 'credential-read',
        reason: `read of credential or ssh file ${path}`,
        operand: path,
      });
    }
  }
  if (READONLY_DEVICE_TOOLS.has(input.toolName)) {
    return withTrust({
      tier: 'readonly',
      signal: 'device-readonly-tool',
      reason: `${input.toolName} is a read-only device probe`,
      operand: input.path ?? '',
    });
  }
  if (input.toolName === 'device_exec') {
    const judged = classifyCommand(input.command ?? '');
    return withTrust({ ...judged.judgement, operand: judged.operand });
  }
  if (input.toolName === 'device_file_write') {
    const path = input.path ?? '';
    return withTrust({ ...classifyWritePath(path), operand: path });
  }
  if (input.toolName === 'device_deploy') {
    const remote = input.remotePath ?? '';
    let best = classifyWritePath(remote);
    if (input.startCommand) best = higher(best, classifyCommand(input.startCommand).judgement);
    if (input.healthCommand) best = higher(best, classifyCommand(input.healthCommand).judgement);
    const operand = [remote, input.startCommand ?? ''].filter((part) => part !== '').join('\n');
    return withTrust({ ...best, operand });
  }
  if (input.sideEffect === 'device_mutation') {
    return withTrust({
      tier: 'reversible',
      signal: 'device-mutation-unclassified',
      reason: 'device mutation with no recognized lockout pattern',
      operand: input.command ?? input.path ?? input.remotePath ?? '',
    });
  }
  return null;
}
