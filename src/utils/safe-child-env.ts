/**
 * Environment passed to child processes.
 *
 * Secrets (API keys, device passwords, private-key paths) are stripped.
 * Every `MOSS_DEVICE_*` variable is also stripped. The process still has them;
 * `formatDeviceEnvReport` lists the names that are set, never the values, so a
 * shell inspection is not mistaken for "unset".
 */

const DANGEROUS_ENV_KEYS = [
  'SSHPASS',
  'MOSS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'AZURE_API_KEY',
  'HF_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'DATABASE_URL',
  'REDIS_URL',
  'MONGODB_URI',
];

/** Known device variables. All of them are hidden from child processes. */
export const DEVICE_ENV_KEYS = [
  'MOSS_DEVICE_HOST',
  'MOSS_DEVICE_PORT',
  'MOSS_DEVICE_USER',
  'MOSS_DEVICE_KIND',
  'MOSS_DEVICE_ID',
  'MOSS_DEVICE_PASSWORD',
  'MOSS_DEVICE_KEY',
  'MOSS_DEVICE_KEY_PASSPHRASE',
] as const;

const DANGEROUS_ENV_KEY_PATTERNS = [
  /(^|_)(API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?)(_|$)/i,
];

function isDangerousEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    DANGEROUS_ENV_KEYS.includes(normalized) ||
    DANGEROUS_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key))
  );
}

function isStrippedFromChild(key: string): boolean {
  if (key.startsWith('MOSS_DEVICE_')) return true;
  return isDangerousEnvKey(key);
}

export function safeChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isStrippedFromChild(key)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}

function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean((env[key] ?? '').trim());
}

/**
 * Names of `MOSS_DEVICE_*` variables set on this process. Values are never
 * included. Shell children do not receive these variables; this report is how
 * the agent learns they are set.
 */
export function formatDeviceEnvReport(env: NodeJS.ProcessEnv = process.env): string {
  const names = new Set<string>();
  for (const key of DEVICE_ENV_KEYS) {
    if (isSet(env, key)) names.add(key);
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('MOSS_DEVICE_') && isSet(env, key)) names.add(key);
  }
  if (names.size === 0) {
    return 'No MOSS_DEVICE_* variables are set in the Moss process.';
  }
  return (
    'Set in the Moss process but hidden from shell subprocesses (names only, values not shown): ' +
    `${[...names].join(', ')}.`
  );
}

export function commandInspectsProcessEnv(command: string): boolean {
  return /\b(printenv|env)\b/.test(command) || /MOSS_DEVICE_/.test(command);
}

export function deviceEnvFootnote(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!commandInspectsProcessEnv(command)) return '';
  return `\n\n[moss] ${formatDeviceEnvReport(env)}`;
}
