/**
 * Exact-value redaction for secrets the process already knows: env vars whose
 * names look like keys, tokens, secrets, or passwords; the configured provider
 * API key; and credential values stored in Moss config.json / devices.json.
 * Values shorter than 8 characters are masked only in their schema field
 * (or credential argv slot), never by whole-text replacement. Pattern
 * redaction cannot see a key that was dumped byte by byte and typed back out
 * in prose.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD)/i;
const MIN_SECRET_LENGTH = 8;

const noted = new Set<string>();
let storedCache: { key: string; values: string[]; shortValues: string[] } | null = null;

/** Remember a secret the host already resolved, such as the provider API key. */
export function noteKnownSecret(value: string | undefined): void {
  if (!isUsableSecret(value)) return;
  noted.add(value);
  storedCache = null;
}

/**
 * If the text ends with a proper prefix of a known secret, return the index
 * where that prefix starts so the caller can keep it off screen until the
 * value is complete. A full secret is left in place for exact-match redaction.
 */
export function knownSecretPrefixCut(text: string, env: NodeJS.ProcessEnv = process.env): number {
  let cut = text.length;
  for (const secret of collectKnownSecretValues(env)) {
    const max = Math.min(text.length, secret.length - 1);
    for (let len = max; len >= 4; len -= 1) {
      if (secret.startsWith(text.slice(text.length - len))) {
        cut = Math.min(cut, text.length - len);
        break;
      }
    }
  }
  return cut;
}

export function redactKnownSecretValues(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!text) return text;
  // Field position first, and only for short values stored in Moss config.
  // A 7-character password must not be replaced in unrelated text.
  let out = redactConfigSecretFields(text, storedShortSecrets(env));
  for (const secret of collectKnownSecretValues(env)) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join('[REDACTED]');
  }
  return out;
}

/** Whole numbered read, so a flag and its value can sit on different lines. */
export function redactConfigSecretFieldsInView(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return redactConfigSecretFields(text, storedShortSecrets(env));
}

function collectKnownSecretValues(env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>(noted);
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !isUsableSecret(value)) continue;
    found.add(value);
  }
  for (const value of userApiKeyEnvValues(env)) found.add(value);
  for (const value of mossStoredSecrets(env)) found.add(value);
  return [...found].sort((a, b) => b.length - a.length);
}

/** User-level `apiKeyEnv` only. A project `.moss/config.json` must not name a var to read. */
function userApiKeyEnvValues(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  const home = (env.HOME || env.USERPROFILE || '').trim();
  const paths: string[] = [];
  const explicit = (env.MOSS_CONFIG_DIR || '').trim();
  if (explicit) paths.push(path.join(explicit, 'config.json'));
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  if (xdg) paths.push(path.join(xdg, 'moss', 'config.json'));
  if (home) paths.push(path.join(home, '.config', 'moss', 'config.json'));
  for (const file of paths) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { apiKeyEnv?: unknown };
      const name = typeof parsed.apiKeyEnv === 'string' ? parsed.apiKeyEnv.trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const value = env[name];
      if (isUsableSecret(value)) values.push(value);
    } catch {
      // Not a config document.
    }
  }
  return values;
}

function isUsableSecret(value: string | undefined): value is string {
  return Boolean(value && value.length >= MIN_SECRET_LENGTH && !value.includes('\0'));
}

function storedCacheKey(env: NodeJS.ProcessEnv): string {
  return [
    env.HOME ?? '',
    env.USERPROFILE ?? '',
    env.XDG_CONFIG_HOME ?? '',
    env.MOSS_CONFIG_DIR ?? '',
    process.cwd(),
  ].join('|');
}

function loadStoredSecrets(env: NodeJS.ProcessEnv): { values: string[]; shortValues: string[] } {
  const key = storedCacheKey(env);
  if (storedCache?.key === key) return storedCache;
  const exact = new Set<string>();
  const short = new Set<string>();
  for (const file of storedConfigPaths(env)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      collectConfigSecretValues(JSON.parse(raw) as unknown, exact, short);
    } catch {
      // A non-JSON credential file is not scanned as a document.
    }
  }
  storedCache = { key, values: [...exact], shortValues: [...short] };
  return storedCache;
}

function mossStoredSecrets(env: NodeJS.ProcessEnv): string[] {
  return loadStoredSecrets(env).values;
}

function storedShortSecrets(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  return new Set(loadStoredSecrets(env).shortValues);
}

function storedConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const home = (env.HOME || env.USERPROFILE || os.homedir()).trim() || os.homedir();
  const dirs = [
    path.join(home, '.moss'),
    path.join(home, '.config', 'moss'),
    path.join(process.cwd(), '.moss'),
  ];
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  if (xdg) dirs.push(path.join(xdg, 'moss'));
  const explicit = (env.MOSS_CONFIG_DIR || '').trim();
  if (explicit) dirs.push(explicit);
  const paths: string[] = [];
  for (const dir of dirs) {
    paths.push(path.join(dir, 'config.json'), path.join(dir, 'devices.json'));
  }
  return paths;
}

/**
 * Secret fields of a Moss config.json or devices.json document. Match is the
 * field itself, not a substring (`password` does not claim `passwordEnvVar`).
 * Keys ending in `Env` / `EnvVar` are variable names and stay visible.
 * `enc:` ciphertext is collected at any length, from any field.
 */
const CONFIG_SECRET_FIELDS = new Set([
  'apiKey',
  'token',
  'bearer',
  'pass',
  'passphrase',
  'password',
  'passwordValue',
]);

/** Header names whose values are credentials. Exact, ignoring case. */
const CONFIG_SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]);

/** Argv flags whose following value is a credential (`--password`, `--pass`). */
const CONFIG_SECRET_FLAGS = new Set([
  '--password',
  '--pass',
  '--passphrase',
  '--token',
  '--api-key',
  '--apikey',
]);

const ENV_NAME_KEY = /Env(?:Var)?$/;

/**
 * Main's stored-secret key test. Long values under these names join the
 * exact-value set. `*Env` / `*EnvVar` are variable names and stay out.
 */
const CREDENTIAL_LIKE_KEY = /(?:api[_-]?key|token|secret|password|passwd|credential)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function remember(value: string, out: Set<string>): void {
  if (!value || value.includes('\0') || value.includes('${')) return;
  out.add(value);
}

/** `enc:` payload of any length. The bare prefix is not a stored secret. */
function rememberEnc(value: string, out: Set<string>): void {
  if (!value.startsWith('enc:') || value.length <= 'enc:'.length) return;
  remember(value, out);
}

/**
 * Whole-text replacement is only safe for values long enough that they are
 * not ordinary words. `sunrise` (the RDK default password) is 7 characters;
 * putting it in this set would mask that word in every tool result. Short
 * schema values are masked by field position instead.
 */
function rememberField(value: string, exact: Set<string>, short: Set<string>): void {
  if (value.length >= MIN_SECRET_LENGTH) {
    remember(value, exact);
    return;
  }
  if (keepConfigFieldValue(value)) return;
  short.add(value);
}

/**
 * Placeholders and source expressions stay visible. Letter-only passwords
 * such as `sunrise` do not: they are real stored credentials.
 */
const FIELD_PLACEHOLDER =
  /^(?:undefined|null|true|false|string|number|boolean|your[-_ ]?(?:api[-_ ]?)?key|changeme|placeholder|todo|xxx+|redacted|\[REDACTED\])$/i;
const PROPERTY_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\[[^\]]+\])?$/;

function keepConfigFieldValue(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('${')) return true;
  if (FIELD_PLACEHOLDER.test(value)) return true;
  if (PROPERTY_CHAIN.test(value)) return true;
  return false;
}

const CONFIG_SECRET_KEY =
  'passwordValue|passphrase|password|apiKey|token|bearer|pass|authorization|proxy-authorization|cookie|x-api-key';
const CONFIG_ARGV_FLAG = '--password|--passphrase|--pass|--token|--api-key|--apikey';

/** A quoted secret field in a config document, including JSON-escaped quotes. */
const RAW_JSON_SECRET_FIELD = new RegExp(
  `"(${CONFIG_SECRET_KEY})"(\\s*:\\s*)"((?:\\\\.|[^"\\\\])*)"`,
  'gi'
);
const ESCAPED_JSON_SECRET_FIELD = new RegExp(
  `\\\\"(${CONFIG_SECRET_KEY})\\\\"(\\s*:\\s*)\\\\"((?:\\\\\\\\.|[^"\\\\])*)\\\\"`,
  'gi'
);
const RAW_JSON_ARGV = new RegExp(
  `"((?:${CONFIG_ARGV_FLAG}))"(\\s*,\\s*(?:\\d+\\t\\s*)?)"((?:\\\\.|[^"\\\\])*)"`,
  'gi'
);
const ESCAPED_JSON_ARGV = new RegExp(
  `\\\\"((?:${CONFIG_ARGV_FLAG}))\\\\"(\\s*,\\s*)\\\\"((?:\\\\\\\\.|[^"\\\\])*)\\\\"`,
  'gi'
);
const RAW_JSON_ARGV_EQ = new RegExp(`"((?:${CONFIG_ARGV_FLAG})=)((?:\\\\.|[^"\\\\])*)"`, 'gi');
const ESCAPED_JSON_ARGV_EQ = new RegExp(
  `\\\\"((?:${CONFIG_ARGV_FLAG})=)((?:\\\\\\\\.|[^"\\\\])*)\\\\"`,
  'gi'
);

function replaceField(
  pattern: RegExp,
  text: string,
  quote: string,
  groups: 2 | 3,
  skipFlags: boolean,
  short: ReadonlySet<string>
): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, (full: string, a: string, b: string, c?: string) => {
    const value = groups === 3 ? c : b;
    if (value === undefined || !short.has(value)) return full;
    if (skipFlags && value.startsWith('-')) return full;
    if (groups === 3) return `${quote}${a}${quote}${b}${quote}[REDACTED]${quote}`;
    return `${quote}${a}[REDACTED]${quote}`;
  });
}

/**
 * Mask a short stored credential only where it sits in a schema field or
 * credential argv slot. Other occurrences of the same word stay visible.
 */
function redactConfigSecretFields(text: string, short: ReadonlySet<string>): string {
  if (short.size === 0 || !text.includes('"')) return text;
  let out = replaceField(RAW_JSON_SECRET_FIELD, text, '"', 3, false, short);
  out = replaceField(RAW_JSON_ARGV, out, '"', 3, true, short);
  out = replaceField(RAW_JSON_ARGV_EQ, out, '"', 2, false, short);
  if (!out.includes('\\"')) return out;
  out = replaceField(ESCAPED_JSON_SECRET_FIELD, out, '\\"', 3, false, short);
  out = replaceField(ESCAPED_JSON_ARGV, out, '\\"', 3, true, short);
  return replaceField(ESCAPED_JSON_ARGV_EQ, out, '\\"', 2, false, short);
}

function isConfigSecretKey(key: string): boolean {
  if (ENV_NAME_KEY.test(key)) return false;
  if (CONFIG_SECRET_FIELDS.has(key)) return true;
  return CONFIG_SECRET_HEADERS.has(key.toLowerCase());
}

function collectArgvSecrets(args: unknown[], exact: Set<string>, short: Set<string>): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const flag = arg.slice(0, eq).toLowerCase();
      if (CONFIG_SECRET_FLAGS.has(flag)) rememberField(arg.slice(eq + 1), exact, short);
      continue;
    }
    if (!CONFIG_SECRET_FLAGS.has(arg.toLowerCase())) continue;
    const next = args[i + 1];
    if (typeof next !== 'string' || next.startsWith('-')) continue;
    rememberField(next, exact, short);
    i += 1;
  }
}

function walkConfigSecrets(
  value: unknown,
  exact: Set<string>,
  short: Set<string>,
  depth: number
): void {
  if (depth > 12) return;
  if (typeof value === 'string') {
    rememberEnc(value, exact);
    return;
  }
  if (Array.isArray(value)) {
    collectArgvSecrets(value, exact, short);
    for (const entry of value) walkConfigSecrets(entry, exact, short, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      if (!ENV_NAME_KEY.test(key)) rememberEnc(entry, exact);
      if (isConfigSecretKey(key)) rememberField(entry, exact, short);
      else if (!ENV_NAME_KEY.test(key) && CREDENTIAL_LIKE_KEY.test(key) && isUsableSecret(entry)) {
        remember(entry, exact);
      }
      continue;
    }
    walkConfigSecrets(entry, exact, short, depth + 1);
  }
}

function collectConfigSecretValues(root: unknown, exact: Set<string>, short: Set<string>): void {
  walkConfigSecrets(root, exact, short, 0);
}
