/**
 * Copy for the destructive-device confirmation.
 *
 * Kept out of `src/cli/tui/app.ts`: the existing approval view
 * (`CliApprovalView`) already renders title, detail, question, and the
 * trust option. TUI and REPL both consume that view; this module only
 * fills it.
 */
export interface DeviceDestructivePromptInput {
  toolName: string;
  operand: string;
  reason: string;
  deviceLabel?: string;
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
  const subject = subjectOf(input.operand) || input.toolName;
  const where = input.deviceLabel ? ` on ${input.deviceLabel}` : '';
  const detail = [
    input.reason,
    'Full mode still runs read-only and reversible device work without asking.',
    'This call is in the destructive tier (lockout or hard to undo).',
  ];
  const question = `Do you want to run this destructive ${input.toolName} command${where}?`;
  const trustOptionLabel = 'Yes, and trust this device for destructive commands this session';
  const text = [
    '',
    `Destructive device operation: ${input.reason}`,
    '',
    `Moss wants to ${input.toolName}${where}:`,
    `  ${subject}`,
    '',
    'Read-only probes and reversible changes (deploys under /home, /opt, /tmp,',
    'package installs, systemctl restart) already run in full mode.',
    'Reboot, flash, system-path writes, network changes, package removal, and',
    'ssh/account edits need a confirmation.',
    '',
    'Allow once [y], trust this device for the session [a], or deny [N]? ',
  ].join('\n');
  const headlessReason =
    `Tool "${input.toolName}" is a destructive device operation (${input.reason}) ` +
    'and Moss is running non-interactively, so it was refused. ' +
    'To allow it: confirm from a TTY, or opt in explicitly with `--trust-device` (this process), ' +
    '`MOSS_DEVICE_TRUST=full`, `permissions.deviceTrust=full`, ' +
    'a `permissions.trustedDevices` entry (or `MOSS_DEVICE_TRUST_DEVICES`) for this board, ' +
    `or an allow rule that matches this call. Deny rules still win.`;
  return {
    title: 'Destructive device operation',
    subject,
    detail,
    question,
    trustOptionLabel,
    text,
    headlessReason,
  };
}
