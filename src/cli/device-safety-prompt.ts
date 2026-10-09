/**
 * Copy for a gated device confirmation (destructive or sensitive).
 *
 * Kept out of `src/cli/tui/app.ts`: the existing approval view
 * (`CliApprovalView`) already renders title, detail, question, and the
 * trust option. TUI and REPL both consume that view; this module only
 * fills it. Wording follows the CLI locale (`LC_ALL` / `LC_MESSAGES` / `LANG`).
 */
import { cliLocale, isZhLocale } from './cli-locale.js';

export interface DeviceDestructivePromptInput {
  toolName: string;
  tier: 'sensitive' | 'destructive';
  operand: string;
  reason: string;
  deviceLabel?: string;
  /** English scope label. What answering `a` will trust. */
  trustEn?: string;
  /** zh-CN scope label. */
  trustZh?: string;
  /** Test override. Defaults to the process locale. */
  locale?: string;
}

export interface DeviceDestructivePrompt {
  title: string;
  subject: string;
  detail: string[];
  question: string;
  trustOptionLabel: string;
  /** Flat prompt for the readline REPL asker. */
  text: string;
  /** Headless refusal. Tells the operator how to opt in; does not suggest that full mode is enough. */
  headlessReason: string;
}

function subjectOf(operand: string): string {
  const line = operand.split('\n')[0] ?? operand;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function deviceDestructivePrompt(
  input: DeviceDestructivePromptInput
): DeviceDestructivePrompt {
  const zh = isZhLocale(input.locale ?? cliLocale());
  const subject = subjectOf(input.operand) || input.toolName;
  const sensitive = input.tier === 'sensitive';
  const trustLabel =
    (zh ? input.trustZh : input.trustEn) ??
    (zh ? '本机上的同一条命令' : 'this same command on this device');
  const where = input.deviceLabel
    ? zh
      ? `（${input.deviceLabel}）`
      : ` on ${input.deviceLabel}`
    : '';

  if (zh) {
    const title = sensitive ? '敏感的设备读取' : '毁灭性设备操作';
    const kind = sensitive
      ? '这次调用会读取密钥或 ssh 配置，不会修改设备。'
      : '这次调用属于毁灭性档：可能锁死开发板，或很难撤销。';
    const detail = [
      kind,
      'full 模式仍会直接执行只读探测和可逆变更（部署到 /home、/opt、/tmp，安装软件包，systemctl restart）。',
      `选 a 将在本会话信任：${trustLabel}`,
    ];
    const question = sensitive
      ? `要使用 ${input.toolName} 读取这份密钥吗${where}？`
      : `要在设备上执行这条毁灭性的 ${input.toolName} 命令吗${where}？`;
    const trustOptionLabel = `是，并且本会话信任：${trustLabel}`;
    const text = [
      '',
      `${title}${where}`,
      `  ${subject}`,
      '',
      kind,
      '只读探测和可逆变更已经会在 full 模式下直接执行。',
      sensitive
        ? '读取 /etc/shadow、私钥、sshd_config 或 authorized_keys 需要确认。'
        : '重启、刷机、写入系统路径、改网络、卸载系统包、修改 ssh 或账号需要确认。',
      '',
      `执行一次 [y]，本会话信任（${trustLabel}）[a]，或拒绝 [N]？ `,
    ].join('\n');
    const headlessReason =
      `工具「${input.toolName}」是${sensitive ? '敏感的设备读取' : '毁灭性设备操作'}，` +
      '而 Moss 正以非交互方式运行，因此已拒绝。' +
      '要放行：在 TTY 上确认，或显式信任：`--trust-device`（仅本进程）、' +
      '`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust=full`、' +
      '匹配这块板的 `permissions.trustedDevices` 或 `MOSS_DEVICE_TRUST_DEVICES`，' +
      '或一条匹配本次调用的 allow 规则。deny 规则仍然优先。';
    return { title, subject, detail, question, trustOptionLabel, text, headlessReason };
  }

  const title = sensitive ? 'Sensitive device read' : 'Destructive device operation';
  const kind = sensitive
    ? 'This call reads a secret (credentials or ssh configuration). It does not change the device.'
    : 'This call is in the destructive tier (lockout or hard to undo).';
  const whereEn = input.deviceLabel ? ` on ${input.deviceLabel}` : '';
  const detail = [
    input.reason,
    'Full mode still runs read-only and reversible device work without asking.',
    kind,
    `Answering a trusts: ${trustLabel}`,
  ];
  const question = sensitive
    ? `Do you want to read this secret with ${input.toolName}${whereEn}?`
    : `Do you want to run this destructive ${input.toolName} command${whereEn}?`;
  const trustOptionLabel = `Yes, and for this session trust: ${trustLabel}`;
  const text = [
    '',
    `${title}: ${input.reason}`,
    '',
    `Moss wants to ${input.toolName}${whereEn}:`,
    `  ${subject}`,
    '',
    'Read-only probes and reversible changes (deploys under /home, /opt, /tmp,',
    'package installs, systemctl restart) already run in full mode.',
    sensitive
      ? 'Reading /etc/shadow, private keys, sshd_config, or authorized_keys needs a confirmation.'
      : 'Reboot, flash, system-path writes, network changes, package removal, and ssh/account edits need a confirmation.',
    '',
    `Allow once [y], trust for this session (${trustLabel}) [a], or deny [N]? `,
  ].join('\n');
  const headlessReason =
    `Tool "${input.toolName}" is a ${sensitive ? 'sensitive device read' : 'destructive device operation'} (${input.reason}) ` +
    'and Moss is running non-interactively, so it was refused. ' +
    'To allow it: confirm from a TTY, or opt in explicitly with `--trust-device` (this process), ' +
    '`MOSS_DEVICE_TRUST=full`, `permissions.deviceTrust=full`, ' +
    'a `permissions.trustedDevices` entry (or `MOSS_DEVICE_TRUST_DEVICES`) for this board, ' +
    'or an allow rule that matches this call. Deny rules still win.';
  return { title, subject, detail, question, trustOptionLabel, text, headlessReason };
}
