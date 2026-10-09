/**
 * Device-bench safety denylist.
 *
 * This is the runner's own guard for task definitions and the simulated SSH
 * server. It is not the device-mutation risk classifier (that lives in the
 * device-safety stream). A match refuses the command before it runs.
 */

const FORBIDDEN = [
  { id: 'power', re: /\b(?:reboot|shutdown|halt|poweroff)\b/i },
  { id: 'password', re: /\b(?:passwd|chpasswd)\b/i },
  {
    id: 'reflash',
    re: /\b(?:fastboot|rkdeveloptool|upgrade_tool)\b|\bdd\b[^;\n]{0,120}\bof=\/dev\//i,
  },
  { id: 'ssh-config', re: /sshd_config|\/etc\/ssh\//i },
  { id: 'firewall', re: /\b(?:iptables|ip6tables|\bnft\b|ufw|netplan|nmcli)\b/i },
  { id: 'network', re: /\bip\s+(?:link|addr|route)\s+(?:set|add|del|replace|flush|change)\b/i },
  { id: 'ssh-service', re: /\bsystemctl\s+(?:restart|stop|disable|mask)\s+sshd?\b/i },
];

export function findForbidden(text) {
  const hits = [];
  const source = String(text ?? '');
  for (const rule of FORBIDDEN) {
    rule.re.lastIndex = 0;
    if (rule.re.test(source)) hits.push(rule.id);
  }
  return hits;
}

export function commandText(task) {
  const fields = ['prerequisites', 'setup', 'oracle', 'acceptance', 'cleanup'];
  const parts = [];
  for (const field of fields) {
    const value = task[field];
    if (Array.isArray(value)) parts.push(value.join('\n'));
  }
  for (const spec of task.evidence ?? []) {
    if (spec && typeof spec.probe === 'string') parts.push(spec.probe);
  }
  return parts.join('\n');
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Quote one argument for the shell that runs the acceptance command.
 * POSIX sh uses single quotes. Windows cmd.exe does not strip them, so a
 * single-quoted path becomes part of the filename. cmd double quotes are
 * passed through by `acceptanceShell` (`windowsVerbatimArguments`).
 */
export function quoteForShell(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') return `"${text.replaceAll('"', '""')}"`;
  return shellQuote(text);
}

export function redactSecrets(text, secrets = secretValues()) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function secretValues() {
  return [
    process.env.RDK_S600_PASSWORD,
    process.env.MOSS_DEVICE_PASSWORD,
    process.env.MOSS_BENCH_API_KEY,
    process.env.MOSS_DEVICE_KEY_PASSPHRASE,
  ].filter((value) => typeof value === 'string' && value.length > 0);
}
