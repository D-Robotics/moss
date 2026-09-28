const DANGEROUS_ENV_KEYS = [
  'SSHPASS',
  'MOSS_DEVICE_PASSWORD',
  'MOSS_DEVICE_HOST',
  'MOSS_DEVICE_USER',
  'MOSS_DEVICE_KEY',
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

const DANGEROUS_ENV_KEY_PATTERNS = [
  /(^|_)(API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(_|$)/i,
];

function isDangerousEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    DANGEROUS_ENV_KEYS.includes(normalized) ||
    DANGEROUS_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key))
  );
}

export function safeChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isDangerousEnvKey(key)) continue;
    env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
