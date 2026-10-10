/**
 * Safety controls a project or ancestor `.env` must never set.
 *
 * Trusted folders are not an exception. These names work only from the real
 * process environment or from CLI flags, the same rule as
 * `MOSS_TRUST_WORKSPACE` and `MOSS_CONFIG_DIR`. Matching is case-insensitive.
 *
 * There is no separate sandbox, hook, yolo, permission, or skip switch in
 * src/. Sandbox confinement follows `MOSS_SAFETY_MODE`
 * (full-access drops the workspace write roots). Project hooks run only after
 * a trust grant, and `MOSS_TRUST_WORKSPACE` is in this list. Tool-loop limits
 * accept `off`, which removes the stop, so they are included.
 */

export const DOTENV_SAFETY_ENV_KEYS = [
  'MOSS_APPROVAL_POLICY',
  'MOSS_ASK_FOR_APPROVAL',
  'MOSS_AUTO_APPROVE',
  'MOSS_CLI_AUTO_APPROVE',
  'MOSS_CLI_SAFETY_MODE',
  'MOSS_DENIED_TOOLS',
  'MOSS_DEVICE_TRUST',
  'MOSS_DEVICE_TRUST_DEVICES',
  'MOSS_DISABLE_NUDGES',
  'MOSS_NET_ALLOW_HOSTS',
  'MOSS_PLAN_GATE',
  'MOSS_SAFETY_MODE',
  'MOSS_TELEMETRY_ALLOW',
  'MOSS_TOOL_LOOP_DISCOVERY_FAILURE_LIMIT',
  'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT',
  'MOSS_TOOL_LOOP_FAILURE_LIMIT',
  'MOSS_TOOL_LOOP_IDENTICAL_LIMIT',
  'MOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT',
  'MOSS_TOOL_LOOP_TOTAL_LIMIT',
  'MOSS_TRUST_WORKSPACE',
  'MOSS_TRUSTED_TOOLS',
  'MOSS_WEB_SEARCH_VARIATION_LIMIT',
] as const;

const SAFETY_KEYS = new Set<string>(DOTENV_SAFETY_ENV_KEYS);

export function isDotenvSafetyEnvKey(key: string): boolean {
  return SAFETY_KEYS.has(key.toUpperCase());
}

const ignoredByFile = new Map<string, Set<string>>();

/** Record a safety key found in one `.env`. Does not apply the value. */
export function noteDotenvSafetyEnvKey(envPath: string, key: string): void {
  const canonical = key.toUpperCase();
  if (!SAFETY_KEYS.has(canonical)) return;
  let keys = ignoredByFile.get(envPath);
  if (!keys) {
    keys = new Set();
    ignoredByFile.set(envPath, keys);
  }
  keys.add(canonical);
}

/**
 * One line per `.env` that named a safety key. The line lists every ignored
 * key and that file's path. Clears the queue.
 */
export function takeDotenvSafetyEnvNotices(zh: boolean): string[] {
  const lines: string[] = [];
  for (const [envPath, keys] of ignoredByFile) {
    if (keys.size === 0) continue;
    const names = [...keys].sort().join(', ');
    lines.push(
      zh
        ? `[moss] 已忽略 .env（${envPath}）中的安全环境变量：${names}`
        : `[moss] Ignored safety env from ${envPath}: ${names}`
    );
  }
  ignoredByFile.clear();
  return lines;
}
